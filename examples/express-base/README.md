# Express + Base

A paid route in 20 lines ([server.js](server.js)), and an agent that pays it
([agent.js](agent.js)).

```bash
pnpm install
OCT_ADDRESS=0xYourSettlementAddress pnpm start
```

Then, in another terminal:

```bash
pnpm agent
```

Without a funded wallet you still see the interesting half — the 402 challenge,
with the price, the network, and where to pay:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "4000",
      "payTo": "0xYourSettlementAddress",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    }
  ],
  "errorDetail": {
    "code": "payment_required",
    "message": "This route costs 0.004000 USDC.",
    "doc": "https://octroi.sh/docs/errors#payment_required"
  }
}
```

With `OCT_AGENT_KEY` set to a Base Sepolia wallet holding USDC, the agent pays
and gets the content, plus an `x-octroi-receipt` header.

Get testnet USDC from the [Circle faucet](https://faucet.circle.com/).

## Going to mainnet

Change `network` to `"base"`. Nothing else — the asset address and EIP-712
domain follow from the network.

Before you do, run the doctor:

```bash
npx @octroi/gate doctor --pay-to $OCT_ADDRESS --network base --skip-self-payment
```

It checks the config, the facilitator, and your clock. Clock skew is the one
that bites silently: our challenge expiry meets the facilitator's timestamp
validation, and a drifting clock looks like "payments randomly stopped
working".
