package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

const SubmitCanvasCommandOperation = "submitCanvasCommand"
const MaxCommandGraphBytes = 1024 * 1024

type GraphValidator func(map[string]any) ([]string, error)
type CommandSnapshot struct {
	Revision      int64
	EventSequence int64
	Graph         json.RawMessage
}
type StoredCommandReceipt struct {
	RequestHash string
	Receipt     domain.CommandReceipt
}
type CommandRepositories interface {
	LockCommandKey(context.Context, string, string, string, string) error
	OwnedCommandSnapshot(context.Context, string, string, bool) (CommandSnapshot, error)
	FindCommandReceipt(context.Context, string, string, string, string) (*StoredCommandReceipt, error)
	CommandReceipt(context.Context, string, string, string) (domain.CommandReceipt, error)
	AuthorizeCommandAssets(context.Context, string, []string) error
	CommitCanvasCommand(context.Context, string, string, CommandSnapshot, json.RawMessage, string, string, domain.CommandReceipt) error
}
type CommandUnitOfWork interface {
	WithinCommands(context.Context, func(CommandRepositories) error) error
}
type CommandService struct {
	uow               CommandUnitOfWork
	validate          GraphValidator
	now               func() time.Time
	newID             func() string
	resolveCapability func(context.Context, string, *domain.CommandCapability) error
}

func (s *CommandService) WithCapabilityResolver(resolve func(context.Context, string, *domain.CommandCapability) error) {
	s.resolveCapability = resolve
}

func NewCommandService(uow CommandUnitOfWork, validate GraphValidator) (*CommandService, error) {
	if uow == nil || validate == nil {
		return nil, errors.New("canvas command unit of work and graph validator required")
	}
	return &CommandService{uow: uow, validate: validate, now: time.Now, newID: func() string { return "cmd_" + strings.ReplaceAll(uuid.NewString(), "-", "") }}, nil
}
func NormalizeCommandKey(key string) (string, error) {
	value, err := uuid.Parse(key)
	if err != nil || value == uuid.Nil || !strings.EqualFold(value.String(), key) {
		return "", domain.ErrCommandInvalid
	}
	return value.String(), nil
}
func CanvasCommandHash(project string, expected int64, raw json.RawMessage) (string, error) {
	if !domain.ValidCommandID(project) || expected < 1 || expected >= math.MaxInt32 {
		return "", domain.ErrCommandInvalid
	}
	var body any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&body) != nil {
		return "", domain.ErrCommandInvalid
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(map[string]any{"operation": SubmitCanvasCommandOperation, "params": map[string]any{"projectId": project}, "precondition": map[string]any{"expectedRevision": expected}, "body": body}) != nil {
		return "", domain.ErrCommandInvalid
	}
	sum := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:]), nil
}
func (s *CommandService) Submit(ctx context.Context, owner, project string, expected int64, key string, raw json.RawMessage) (domain.CommandReceipt, error) {
	var result domain.CommandReceipt
	if owner == "" || !domain.ValidCommandID(project) {
		return result, domain.ErrCommandInvalid
	}
	normalizedKey, err := NormalizeCommandKey(key)
	if err != nil {
		return result, err
	}
	command, err := domain.ParseCommand(raw)
	if err != nil {
		return result, err
	}
	hash, err := CanvasCommandHash(project, expected, raw)
	if err != nil {
		return result, err
	}
	needsModels := false
	for _, op := range command.Operations {
		needsModels = needsModels || op.Capability != nil
	}
	if needsModels {
		// Preserve replay even if a once-valid model is now offline. Resolve any
		// new selection outside the project write transaction.
		found := false
		err = s.uow.WithinCommands(ctx, func(tx CommandRepositories) error {
			if _, e := tx.OwnedCommandSnapshot(ctx, owner, project, false); e != nil {
				return e
			}
			r, e := tx.FindCommandReceipt(ctx, owner, project, SubmitCanvasCommandOperation, normalizedKey)
			if e != nil {
				return e
			}
			if r != nil {
				if r.RequestHash != hash {
					return domain.ErrCommandConflict
				}
				result = r.Receipt
				found = true
			}
			return nil
		})
		if err != nil || found {
			return result, err
		}
		if s.resolveCapability == nil {
			return result, domain.ErrCommandUnsupported
		}
		for _, op := range command.Operations {
			if op.Capability != nil {
				if err = s.resolveCapability(ctx, owner, op.Capability); err != nil {
					return result, err
				}
			}
		}
	}
	err = s.uow.WithinCommands(ctx, func(tx CommandRepositories) error {
		if err := tx.LockCommandKey(ctx, owner, project, SubmitCanvasCommandOperation, normalizedKey); err != nil {
			return err
		}
		current, err := tx.OwnedCommandSnapshot(ctx, owner, project, true)
		if err != nil {
			return err
		}
		stored, err := tx.FindCommandReceipt(ctx, owner, project, SubmitCanvasCommandOperation, normalizedKey)
		if err != nil {
			return err
		}
		if stored != nil {
			if stored.RequestHash != hash {
				return domain.ErrCommandConflict
			}
			result = stored.Receipt
			return nil
		}
		// Until an authoritative run/tool-call registry exists, caller-supplied
		// Agent linkage cannot create a trusted audit source or side effect.
		if command.HasAgentContext {
			return domain.ErrAgentContextUnavailable
		}
		if current.Revision != expected {
			return &domain.CommandVersionConflict{Current: current.Revision}
		}
		if current.Revision >= math.MaxInt32 || current.EventSequence < 0 || current.EventSequence == math.MaxInt64 {
			return domain.ErrCommandUnavailable
		}
		graph, delta, err := domain.ApplyCommands(current.Graph, command)
		if err != nil {
			return err
		}
		refs, err := s.validate(graph)
		if err != nil {
			return err
		}
		if err = tx.AuthorizeCommandAssets(ctx, owner, refs); err != nil {
			return err
		}
		encoded, err := json.Marshal(graph)
		if err != nil || len(encoded) > MaxCommandGraphBytes {
			return domain.ErrGraphOperation
		}
		result = domain.CommandReceipt{CommandID: s.newID(), ProjectID: project, State: "COMMITTED", BaseRevision: current.Revision, GraphRevision: current.Revision + 1, EventCursor: strconv.FormatInt(current.EventSequence+1, 10), Delta: delta, CommittedAt: s.now().UTC().Truncate(time.Millisecond)}
		if err = tx.CommitCanvasCommand(ctx, owner, project, current, encoded, normalizedKey, hash, result); err != nil {
			return err
		}
		// The store may normalize display state while committing the graph.
		// Return the same durable receipt used by replay and project events.
		result, err = tx.CommandReceipt(ctx, owner, project, result.CommandID)
		return err
	})
	if err != nil {
		return domain.CommandReceipt{}, err
	}
	return result, nil
}
func (s *CommandService) Receipt(ctx context.Context, owner, project, commandID string) (domain.CommandReceipt, error) {
	var result domain.CommandReceipt
	if owner == "" || !domain.ValidCommandID(project) || !domain.ValidCommandID(commandID) {
		return result, domain.ErrCommandInvalid
	}
	err := s.uow.WithinCommands(ctx, func(tx CommandRepositories) error {
		if _, err := tx.OwnedCommandSnapshot(ctx, owner, project, false); err != nil {
			return err
		}
		var err error
		result, err = tx.CommandReceipt(ctx, owner, project, commandID)
		return err
	})
	return result, err
}
