# emptoken

Local dev tool: signs an employee JWT by employee number (or directly by EmpID) so developers can act as a given employee on employee-side pages (e.g. the 360 assessment employee side) locally, without Lark silent login.

- Signing algorithm and payload match `linapro-employee-core`'s `empcap`: HS256, `{ empId, tenantId, exp, iat }`.
- The signing secret is read only from the local host config `plugin.linapro-employee-core.emp_jwt_secret`; it is never hard-coded or printed.
- Standalone `Go module` used only via `go run`; no server package imports it, so it is never compiled into the server.

## Usage

```bash
# Run from the repo root
go run ./hack/tools/emptoken -emp-no GZ000071
go run ./hack/tools/emptoken -emp-no GZ000071 -ttl 720h -tenant-id 1
go run ./hack/tools/emptoken -emp-id 1907 -tenant-id 1
go run ./hack/tools/emptoken -emp-no GZ000071 -raw   # print the token only
```

| Flag | Description |
| --- | --- |
| `-emp-no` | Moka employee number. Looks up the local table `plugin_linapro_employee_core_employee` (soft-deleted rows excluded); exits with an error if missing or departed. |
| `-emp-id` | Internal EmpID. Skips the lookup and signs directly; requires `-tenant-id`. Active status is still enforced by the backend `EmpAuth`. Mutually exclusive with `-emp-no`. |
| `-tenant-id` | Tenant ID. Required with `-emp-id`; with `-emp-no` it disambiguates a number present in multiple tenants. |
| `-ttl` | Token lifetime, default `720h` (30 days). `empcap` does not cap `exp`. |
| `-config` | Host config path; defaults to searching upward from the cwd for `apps/lina-core/manifest/config/config.yaml`. |
| `-raw` | Print only the token, for scripts or `curl`. |

## Output

Employee name, number, `empId`, `tenantId`, expiry, the token, and a script to paste into the browser console on a same-origin employee page: it writes `linapro:emp-auth-token` and `linapro:emp-lark-app-id` (value `local`) and redirects to `/eval-360/emp/dashboard`. The script handles both hash routing (production build) and history routing (vite dev). Chrome blocks the first paste into the console; type `allow pasting` manually and press Enter, then paste again.

## Prerequisites

- `linapro-employee-core` is installed and enabled on the local host;
- the target employee exists in the local employee table (normally written by the directory sync).

## Verification

```bash
cd hack/tools/emptoken
go build ./... && go vet ./... && go test ./...
```

Unit tests verify tokens with `empcap.VerifyToken` itself, so signed tokens are guaranteed to match the backend parsing logic; `empcap` is referenced only from tests. API check:

```bash
TOKEN=$(go run ./hack/tools/emptoken -emp-no GZ000071 -raw)
curl -H "Authorization: Bearer $TOKEN" http://localhost:9120/x/linapro-eval-360/api/v1/eval/emp/whoami
```
