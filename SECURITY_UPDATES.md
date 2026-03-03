# Security Updates and Dependency Management

## Summary

All Dependabot security alerts have been resolved. The repository currently has **0 vulnerabilities** in both the main project and the mcp-server subdirectory.

## Recent Security Fixes (Previously Applied)

The following security vulnerabilities were fixed by Dependabot in earlier PRs:

### Main Project Dependencies

1. **hono** (in mcp-server)
   - Updated: 4.12.1 → 4.12.4 (PR #35)
   - Fixed: SSE Control Field Injection, Cookie Attribute Injection, Middleware Bypass
   - Severity: High
   - Advisories: GHSA-p6xx-57qc-3wxr, GHSA-5pq2-9x2x-5p6w, GHSA-q5qw-h33p-qvwr

2. **undici** (in mcp-server)
   - Updated: 6.21.3 → 6.23.0 (PR #22)
   - Fixed: Content-Encoding resource exhaustion vulnerability
   - CVE: CVE-2026-22036
   - Severity: High

3. **body-parser** (in mcp-server)
   - Updated: 2.2.0 → 2.2.2 (PR #21)
   - Fixed: Security vulnerability CVE-2025-13466
   - Severity: High
   - Advisory: GHSA-wqch-xfxh-vrr4

4. **@modelcontextprotocol/sdk** (in mcp-server)
   - Updated: 1.18.2 → 1.25.2 (PR #20)
   - Fixed: ReDoS in UriTemplate regex patterns
   - Severity: Medium

5. **qs** (in mcp-server)
   - Updated: 6.14.0 → 6.14.1 (PR #19)
   - Fixed: Array length validation and custom decoder null handling
   - Severity: Medium

6. **js-yaml**
   - Updated: 3.14.1 → 3.14.2 (PR #14)
   - Updated: 4.1.0 → 4.1.1 (PR #11)
   - Fixed: Prototype pollution in merge (<<) operator
   - Severity: High

## Latest Updates (This PR)

### Dependency Updates

Updated the following dependencies to their latest compatible versions:

#### mcp-server subdirectory

1. **@modelcontextprotocol/sdk**
   - Updated: 1.26.0 → 1.27.1
   - Type: Minor version update
   - Change: Fixed version pin to allow patch updates (changed from `"1.26.0"` to `"^1.26.0"`)

2. **execa**
   - Updated: 9.6.0 → 9.6.1
   - Type: Patch version update

3. **tsx**
   - Updated: 4.20.6 → 4.21.0
   - Type: Minor version update

4. **typescript**
   - Updated: 5.9.2 → 5.9.3
   - Type: Patch version update

### Remaining Available Updates

The following major version updates are available but not applied to avoid breaking changes:

- **better-sqlite3**: 11.10.0 → 12.6.2 (major version)
- **undici**: 6.23.0 → 7.22.0 (major version)
- **zod**: 3.25.76 → 4.3.6 (major version)
- **eslint**: 9.39.3 → 10.0.2 (major version)
- **@types/node**: 22.19.13 → 25.3.3 (major version)

These will be evaluated separately as they may require code changes.

## Verification

All changes have been verified:

- ✅ **npm audit**: 0 vulnerabilities in both projects
- ✅ **Tests**: All 51 tests passing
- ✅ **Build**: TypeScript compilation successful

## Maintenance Notes

- All security-critical updates have been applied
- Package versions are now on a flexible update strategy (using `^` prefix)
- Regular dependency updates should be performed monthly
- Major version updates should be evaluated separately for breaking changes

## Last Updated

2026-03-03
