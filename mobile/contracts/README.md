# Native contract fixtures

Both apps speak the existing Loom runner JSON WebSocket contract and share this
synthetic cryptographic fixture. Protocol and calls are defined in
src/shared/runner-contract.ts and src/shared/ipc-contract.ts.

Run `node mobile/contracts/generate-fixtures.mjs` to regenerate trust-fixture.json.
The generator creates ephemeral signing keys and discards all private material.
The fixture contains a synthetic Google-shaped RS256 JWT, JWKS, Ed25519 host proof,
DNS TXT answer and signed transport binding. The TLS fingerprint intentionally
contains `/` to exercise canonical signed JSON across Swift and Kotlin.

The fixed `now` is a test clock in milliseconds. Native tests must inject it;
this fixture is expired outside that clock and cannot authenticate to Loom.
Mutate expected identities, DNS replies and signatures to verify fail-closed behavior.
