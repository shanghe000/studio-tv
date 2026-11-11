package domain

import (
	"errors"
	"time"
)

var ErrMessageNotFound = errors.New("assistant message not visible")
var ErrTaskActive = errors.New("assistant task affected by operation is active")
var ErrDeletionTooLarge = errors.New("assistant turn deletion exceeds bounded message count")
var ErrLifecycleUnavailable = errors.New("assistant lifecycle persistence unavailable")
var ErrClientToolsUnavailable = errors.New("persisted client tools require unsupported protocol")

const MaxDeletionMessages = 1000

type MessageDeletion struct {
	ConversationID       string    `json:"conversationId"`
	DeletedMessageIDs    []string  `json:"deletedMessageIds"`
	ConversationRevision int64     `json:"conversationRevision"`
	DeletedAt            time.Time `json:"deletedAt"`
}
type ClientToolPending struct {
	SessionID         string `json:"session_id"`
	Status            string `json:"status"`
	Call              any    `json:"call"`
	ResumeCommand     any    `json:"resume_command"`
	ActiveResume      any    `json:"active_resume"`
	HostEvents        []any  `json:"host_events"`
	TerminalRecovered bool   `json:"terminal_recovered"`
}

func NoPendingClientTools(id string) ClientToolPending {
	return ClientToolPending{SessionID: id, Status: "none", HostEvents: []any{}}
}
