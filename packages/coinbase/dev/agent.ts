/**
 * Dev-only harness shared by the tests and the manual scripts. Not shipped —
 * `dist` is built from `src` alone.
 *
 * Builds an "agent": the reference x402 client wired to a viem wallet, the way
 * a paying customer's code would be.
 */
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

/**
 * `wrapFetchWithPayment` takes `SignerWallet<Chain, Transport, Account>`, which
 * is invariant over viem's chain formatters. An OP-stack chain like
 * `baseSepolia` carries an extra `deposit` transaction type, so it does not
 * match structurally — even though it is exactly what the client expects at
 * runtime, where only `chain.id` and the account are read.
 *
 * One cast, in one place, with the reason written down.
 */
function asX402Signer(wallet: unknown): Parameters<typeof wrapFetchWithPayment>[1] {
  return wallet as Parameters<typeof wrapFetchWithPayment>[1];
}

export interface AgentWallet {
  account: ReturnType<typeof privateKeyToAccount>;
  /**
   * Deliberately `unknown`: viem's extended client type is too large for the
   * compiler to serialize, and the only consumer is {@link asX402Signer}.
   */
  wallet: unknown;
}

export function agentWallet(privateKey: `0x${string}`): AgentWallet {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  }).extend(publicActions);
  return { account, wallet };
}

/** A `fetch` that pays 402s, exactly as an agent would use it. */
export function agentFetch(
  privateKey: `0x${string}`,
  fetchImpl: typeof fetch = fetch,
): { fetch: typeof fetch; address: `0x${string}` } {
  const { account, wallet } = agentWallet(privateKey);
  return {
    fetch: wrapFetchWithPayment(fetchImpl, asX402Signer(wallet)) as typeof fetch,
    address: account.address,
  };
}

/**
 * Runs the client against a 402 and returns the `X-PAYMENT` header it produced,
 * without needing a server that will accept it. Signing costs nothing, so this
 * works with an unfunded key.
 */
export async function capturePaymentHeader(
  privateKey: `0x${string}`,
  target: string,
  challengeBody: unknown,
): Promise<string> {
  let captured: string | undefined;
  const capturing = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const header = new Headers(init?.headers).get("X-PAYMENT");
    if (header) {
      captured = header;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(challengeBody), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await agentFetch(privateKey, capturing).fetch(target).catch(() => undefined);
  if (captured === undefined) {
    throw new Error("the reference x402 client produced no X-PAYMENT header");
  }
  return captured;
}
