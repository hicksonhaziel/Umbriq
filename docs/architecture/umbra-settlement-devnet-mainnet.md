# Umbra Settlement Flow

This document describes the current Umbriq Day 9 and Day 10 settlement design after moving signing out of the API server.

## Product Shape

Umbriq now follows this settlement model:

1. Backend creates a settlement intent.
2. Institution browser wallet executes Umbra operations.
3. Browser sends receipt and proof back to backend.
4. Backend verifies and stores the final settlement artifacts.

That means:

- no institution private key on the API server
- no institution settlement signer env in the backend
- real value-moving settlement happens from the institution wallet

## Current Flow

### Pre-settlement

1. Institution connects wallet in `/dev/dashboard`.
2. Institution authenticates through `POST /auth/nonce` and `POST /auth/verify`.
3. Institution initializes Umbra for the selected network with `POST /umbra/account` persistence.
4. Institution creates an RFQ.
5. Market maker receives the RFQ and submits a signed quote.

### Settlement

1. Institution clicks `Accept Quote`.
2. Backend `POST /settlements/accept` creates a settlement row with status `accepted`.
3. Browser calls `POST /settlements/:id/start` with the selected network.
4. Backend moves settlement to `settling` and returns the RFQ and quote context.
5. Browser executes real Umbra SDK calls using the connected wallet:
   - query registration state
   - register if required
   - deposit public balance into encrypted balance
   - withdraw encrypted balance to the market maker wallet
6. Browser builds:
   - `receipt`
   - `proof`
   - `umbraTxSignature`
7. Browser submits them to `POST /settlements/:id/complete`.
8. Backend verifies the payload against:
   - authenticated institution wallet
   - accepted quote wallet
   - selected network
   - configured mint
   - amount derived from `quote.guaranteedSize`
   - deterministic proof digest
9. Backend marks the settlement `settled` and stores the artifacts.

### Failure Path

If browser execution fails:

1. Browser calls `POST /settlements/:id/fail`.
2. Backend marks the settlement `failed`.
3. RFQ stays `accepted` and quote stays `accepted` so the institution can retry settlement.

## Supported Networks

Umbriq supports exactly:

- `devnet`
- `mainnet`

The selected network lives in the frontend wallet provider and is persisted in browser local storage.

## Network Toggle

The `/dev` shell now exposes a toggle for:

- `devnet`
- `mainnet`

What changes when you toggle:

1. Solana wallet connection endpoint.
2. Umbra client network.
3. Umbra account persistence namespace.
4. Settlement mint and explorer cluster.
5. Settlement execution target network.

The default remains `devnet`.

## Network Config

### Devnet

- RPC: `https://api.devnet.solana.com`
- Explorer cluster: `devnet`
- Settlement mint: devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Decimals: `6`

### Mainnet

- RPC: `https://api.mainnet-beta.solana.com`
- Explorer cluster: `mainnet-beta`
- Settlement mint: mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Decimals: `6`
- Umbra indexer endpoint: `https://utxo-indexer.api.umbraprivacy.com`

## API Responsibilities

The API is now orchestration only.

It is responsible for:

- auth and sessions
- RFQ and quote lifecycle
- settlement intent creation
- settlement state machine
- verification of browser-submitted settlement payloads
- persistence of receipt and proof
- websocket updates

It is not responsible for:

- holding institution signing keys
- signing Umbra transactions
- moving institution funds

## Browser Responsibilities

The browser wallet is now responsible for:

- creating the Umbra signer from the connected wallet
- consenting to Umbra seed derivation
- signing real Solana transactions
- registering Umbra if needed
- performing deposit and withdrawal
- returning the resulting artifacts to the API

## Required Env

### API

Only normal API env is required:

```env
PORT=4000
HOST=0.0.0.0
DATABASE_URL=postgresql://user:password@localhost:5432/umbriq_db?schema=public
REDIS_URL=redis://localhost:6379
SESSION_TTL_SECONDS=28800
```

There is no backend institution settlement signer env anymore.

### Web

Only the API base URL is required for normal local use:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_UMBRA_ENABLE_ANONYMOUS=false
```

The selected network is not env-driven anymore. The user chooses it in the `/dev` UI.

## UI Test Flow

### Institution

1. Start API and web.
2. Open `/dev/dashboard`.
3. Leave the network toggle on `devnet` for first tests.
4. Connect the institution wallet.
5. Click `Authenticate Institution`.
6. Click `Initialize Umbra`.
7. Confirm the settlement panel says:
   - `Execution: browser`
   - `Network: devnet`
   - no issues
8. Create an RFQ and include the market maker wallet.

### Market Maker

1. Open `/dev/mm`.
2. Connect the market maker wallet on the same network.
3. Authenticate.
4. Submit a quote.

### Back to Institution

1. Refresh quotes if needed.
2. Click `Accept Quote`.
3. Approve wallet prompts for Umbra registration or transfers if they appear.
4. Watch settlement progress move through:
   - `Pending`
   - `In Progress`
   - `Complete`
5. Open explorer links for queue and callback signatures.
6. Expand `Receipt / Proof` to inspect stored artifacts.

## What You Need On Devnet

For the institution wallet:

- devnet SOL for fees
- enough devnet USDC for the quote guaranteed size
- Umbra initialization completed on devnet

For the market maker wallet:

- devnet SOL
- ability to receive the configured mint

## Mainnet Readiness

The current architecture is now aligned with a mainnet-safe custody model because the backend does not hold the institution private key.

That said, mainnet still requires operational discipline:

1. Use a real mainnet institution wallet.
2. Use mainnet USDC balance in the institution wallet.
3. Use reliable mainnet RPC infrastructure.
4. Ensure the trader understands that the browser wallet is the real signer.
5. Test explorer links and receipt verification on small size before any larger flow.

## Smoke Test

The repo includes a real devnet smoke script:

```bash
pnpm --filter api smoke:settlement:devnet
```

This script is local-only and separate from the API server custody model.

It uses two local test keys only inside the smoke runner to emulate:

1. institution auth
2. market-maker auth
3. quote acceptance
4. `start`
5. real Umbra execution
6. `complete`

The smoke script does not mean the API server is holding those keys.

### Smoke Env

```env
UMBRA_SMOKE_NETWORK=devnet
UMBRA_SMOKE_INSTITUTION_PRIVATE_KEY_PATH=/absolute/path/to/institution-devnet.json
UMBRA_SMOKE_MARKET_MAKER_PRIVATE_KEY_PATH=/absolute/path/to/mm-devnet.json
UMBRA_SMOKE_TRANSFER_AMOUNT=1
```

## Mainnet Mental Model

This is the correct mental model now:

### Auth and setup

- browser wallet
- backend session
- backend stores per-network Umbra readiness

### Settlement execution

- browser wallet signs
- backend verifies and records

### Compliance and audit

- backend stores receipt and proof
- future viewing-grant work can add selective transparency without server custody
