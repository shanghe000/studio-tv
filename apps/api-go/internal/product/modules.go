// Package product explicitly assembles the product's implemented modules.
package product

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/httpapi"
	assistantHTTP "studiotv.local/service/api/internal/modules/assistant/adapters/http"
	"studiotv.local/service/api/internal/modules/assistant/adapters/postgres"
	"studiotv.local/service/api/internal/modules/assistant/application"
	libraryHTTP "studiotv.local/service/api/internal/modules/library/adapters/http"
	libraryPostgres "studiotv.local/service/api/internal/modules/library/adapters/postgres"
	libraryApplication "studiotv.local/service/api/internal/modules/library/application"
	modelHTTP "studiotv.local/service/api/internal/modules/modelgateway/adapters/http"
	modelApplication "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// RegisterRoutes is called only by bootstrap inside its verified-session and
// live tv.access group. This is an explicit composition seam, not a public
// router constructor. Handlers additionally obtain their owner from that group's
// identity; browser-supplied owner/workspace headers never become an actor.
func RegisterRoutes(router chi.Router, pool *pgxpool.Pool) error {
	return registerRoutes(router, pool, modelApplication.Unconfigured{})
}

// WithModelGateway keeps runtime credentials and adapter construction in bootstrap.
func WithModelGateway(gateway modelApplication.Gateway) func(chi.Router, *pgxpool.Pool) error {
	return func(router chi.Router, pool *pgxpool.Pool) error { return registerRoutes(router, pool, gateway) }
}

func registerRoutes(router chi.Router, pool *pgxpool.Pool, gateway modelApplication.Gateway) error {
	if gateway == nil {
		return errors.New("model gateway is required")
	}
	uow, err := postgres.New(pool)
	if err != nil {
		return err
	}
	service, err := application.New(uow)
	if err != nil {
		return err
	}
	if err := assistantHTTP.RegisterRoutes(router, service, protectedHandler); err != nil {
		return err
	}
	libraryUow, err := libraryPostgres.New(pool)
	if err != nil {
		return err
	}
	libraryService, err := libraryApplication.New(libraryUow)
	if err != nil {
		return err
	}
	if err := libraryHTTP.RegisterRoutes(router, libraryService, protectedHandler); err != nil {
		return err
	}
	return modelHTTP.RegisterRoutes(router, gateway, protectedHandler)
}

func protectedHandler(capability string, next httpapi.Handler) http.HandlerFunc {
	// bootstrap enforces this one tool-level permission for the whole group.
	// Fail closed if a module later requests a different capability until the
	// composition root explicitly supports that additional permission.
	if capability != authorization.TVAccess {
		return httpapi.Wrap(func(http.ResponseWriter, *http.Request) error {
			return errors.New("unsupported product capability")
		})
	}
	return httpapi.Wrap(next)
}
