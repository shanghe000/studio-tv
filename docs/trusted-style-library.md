# STUDIO canvas style library

IMPLEMENTED: the four existing STUDIO `styleLibrary` choices (`cinematic_realism`,
`anime_illustration`, `product_ad`, `editorial_fashion`) are independently seeded
as server-owned SYSTEM PROMPT resources. The seed copies their original ID,
label, prompt, cover and reference URL byte for byte from the published STUDIO Web
baseline, records that source's SHA256, and fixes schema version `1`, resource
revision `1` and catalog version `studio-style-library-1`. The captured resource
catalog and frozen Web bundle are unchanged.

Startup imports the seed transactionally and idempotently; it never overwrites
an existing identity. Collisions, altered catalog content/revisions or audit
metadata fail closed. The existing PROMPT detail and usage routes address the
new resource IDs.

Canvas execution accepts these selections at `data.presetSelections` or
`data.promptSelection.presetSelections`. It reads the trusted server definition,
verifies every client-supplied catalog field, and freezes the full definition in
`STUDIO_PROMPT_CONDITIONS_V1.conditions.styleLibrary` under a USER message. Omitted
legacy schema/revision fields are resolved from the server; supplied mismatches
are rejected. SYSTEM/DEVELOPER text, `studio-authored-1` and template hashes remain
unchanged. Existing user/native conditions remain separate user data.

Cover/reference URLs are catalog metadata, not automatically downloaded model
inputs. Actual images must use the existing owned asset and read-grant pipeline;
the media URL validation boundary is unchanged. Unknown RunningHub `presetId`,
hidden `promptCodes`, other selector categories and unconfigured styles continue
to return `PROMPT_TEMPLATE_NOT_CONFIGURED` (501). No model calls are performed
by catalog import or tests.

Target verification, with an explicit disposable test database for the PG cases:

```sh
cd apps/api-go
go test -mod=vendor -race -count=1 ./internal/modules/execution/application ./internal/modules/execution/adapters/stylecatalog ./internal/product
go vet ./internal/modules/execution/application ./internal/modules/execution/adapters/stylecatalog ./internal/product
```
