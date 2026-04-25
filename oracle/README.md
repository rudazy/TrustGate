# TrustGate Oracle

Public payable trust oracle for Arc testnet. Pay 0.001 USDC, get a trust score.

## Endpoints

- `GET /health` — liveness probe
- `GET /oracle/:address` — score a single address (402 without payment)
- `POST /oracle/batch` — score up to 10 addresses in one paid call
- `GET /oracle/stats` — public stats

## Payment flow (x402-compatible, Arc testnet)

The public x402 facilitator does not support Arc testnet (chain 5042002),
so the oracle verifies payments **directly on-chain**. To pay:

1. Send a USDC transfer to the TrustGate contract recipient
   (`TRUSTGATE_CONTRACT`) on Arc testnet for the required amount.
2. Wait for the tx to confirm.
3. Build the `X-Payment` header — base64 of:
   ```json
   {
     "scheme": "exact",
     "network": "arc-testnet",
     "txHash": "0x...your tx hash...",
     "from": "0x...your address...",
     "amount": "0.001",
     "nonce": "any-uuid"
   }
   ```
4. Send the request with that header. The oracle reads the receipt,
   confirms a USDC `Transfer(_, RECIPIENT, >=amount)` event in the tx,
   then runs the scoring.

Each `txHash` and each `nonce` can only be used once.

## Local dev

```bash
cp .env.example .env
npm install
npm run dev
```

## Deploy to Railway

```bash
# from the oracle/ folder
railway up
# add env vars in Railway dashboard
# attach a volume mounted at /data for persistent stats
```
