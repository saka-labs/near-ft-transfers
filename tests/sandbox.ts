import { Sandbox } from "near-sandbox";

(async () => {
  // Start a sandbox instance with default configuration.
  const sandbox = await Sandbox.start({
    config: {
      rpcPort: 44444,
    }
  });
  try {
    // Your test code here.
    // You can interact with the sandbox via its RPC `sandbox.rpc` etc.
    console.log(`Sandbox RPC available at: ${sandbox.rpcUrl}`);

    console.log("Stopping the sandbox...");
    await sandbox.stop();
  } catch (error) {
    console.error("Error during execution:", error);
  } finally {
    console.log("Tearing down the sandbox...");
    await sandbox.tearDown();
  }
})();
