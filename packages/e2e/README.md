# @diligent/e2e

End-to-end suites organized by the Diligent product boundary under test.

## Suites

| Directory | System under test | Entry boundary |
|---|---|---|
| [`app-server/`](./app-server/) | `DiligentAppServer` and its assembled runtime | JSON-RPC client request |

Future host-level suites should be added as siblings, such as `cli/` or `web/`, rather than extending the
`app-server/` boundary. Shared helpers should remain inside the narrowest suite that owns them until multiple suites
need the same implementation.

## Run

```bash
bun run test:e2e
```
