import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider, type Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { NEAR } from "@near-js/tokens";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";
import { readFile } from "fs/promises";
import { actionCreators } from "@near-js/transactions";

(async () => {
  const sandbox = await Sandbox.start({
    config: {
      rpcPort: 44444,
    },
  });
  try {
    console.log(`Sandbox RPC available at: ${sandbox.rpcUrl}`);
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider;
    const keyPair = KeyPair.fromString(DEFAULT_PRIVATE_KEY);
    const defaultAccount = new Account(
      DEFAULT_ACCOUNT_ID,
      provider,
      new KeyPairSigner(keyPair),
    );

    // Account A is the owner of the contract and the sender
    // Account B is the receiver of the transfer

    // Create account A
    const accountAKeyPair = KeyPair.fromRandom("ED25519");
    await defaultAccount.createAccount(
      `account-a.${DEFAULT_ACCOUNT_ID}`,
      accountAKeyPair.getPublicKey(),
      NEAR.toUnits(10),
    );

    const accountA = new Account(
      "account-a." + DEFAULT_ACCOUNT_ID,
      new JsonRpcProvider({ url: sandbox.rpcUrl }) as Provider,
      new KeyPairSigner(accountAKeyPair),
    );

    // Create account B
    const accountBKeyPair = KeyPair.fromRandom("ED25519");
    await defaultAccount.createAccount(
      `account-b.${DEFAULT_ACCOUNT_ID}`,
      accountBKeyPair.getPublicKey(),
      NEAR.toUnits(10),
    );

    // Deploy FT contract
    const ftContract = await readFile(`${__dirname}/fungible_token.wasm`);
    await accountA.deployContract(ftContract);
    await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "new_default_meta",
      args: {
        owner_id: `account-a.${DEFAULT_ACCOUNT_ID}`,
        total_supply: "1000000",
      },
    });

    // deposit 0.00125 NEAR to register account-b
    await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "storage_deposit",
      args: {
        account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        registration_only: true,
      },
      deposit: NEAR.toUnits(0.00125), // 0.00125 NEAR
    });

    // Batch transfers
    const action = actionCreators.functionCall(
      "ft_transfer",
      {
        receiver_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
        amount: "1",
        memo: null,
      },
      1000000000000n * 3n, // Gas:  3 TGas
      1n, // Attached deposit: 1 yoctoNEAR
    );

    await accountA.signAndSendTransaction({
      receiverId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      actions: Array(100)
        .fill(null)
        .map(() => action),
    });

    // Get the balance of account-b
    const accountBBalance = await accountA.callFunction({
      contractId: `account-a.${DEFAULT_ACCOUNT_ID}`,
      methodName: "ft_balance_of",
      args: {
        account_id: `account-b.${DEFAULT_ACCOUNT_ID}`,
      },
    });
    console.log({ accountBBalance });

    console.log("Stopping the sandbox...");
    await sandbox.stop();
  } catch (error) {
    console.error("Error during execution:", error);
  } finally {
    console.log("Tearing down the sandbox...");
    await sandbox.tearDown();
  }
})();
