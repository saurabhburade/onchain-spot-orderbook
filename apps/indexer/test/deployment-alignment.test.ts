import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type MonadDeployment = {
  deploymentBlock: number;
  contracts: {
    spotClobFactory: string;
    spotClobLens: string;
  };
  defaultMarket: {
    poolId: string;
  };
};

const deployment = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/monad-testnet.json", import.meta.url), "utf8"),
) as MonadDeployment;
const indexerConfig = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
const webConfig = readFileSync(new URL("../../web/lib/clob/config.ts", import.meta.url), "utf8");
const webEnvExample = readFileSync(new URL("../../web/.env.example", import.meta.url), "utf8");
const webEnvLocalUrl = new URL("../../web/.env.local", import.meta.url);

describe("Monad deployment alignment", () => {
  it("keeps the indexer and frontend on the deployment manifest addresses", () => {
    expect(indexerConfig.toLowerCase()).toContain(deployment.contracts.spotClobFactory.toLowerCase());
    expect(indexerConfig).toContain(`start_block: ${deployment.deploymentBlock}`);

    expect(webConfig.toLowerCase()).toContain(deployment.contracts.spotClobFactory.toLowerCase());
    expect(webConfig.toLowerCase()).toContain(deployment.contracts.spotClobLens.toLowerCase());
    expect(webConfig.toLowerCase()).toContain(deployment.defaultMarket.poolId.toLowerCase());
    expect(webConfig).toContain(`"${deployment.deploymentBlock}"`);

    expect(webEnvExample.toLowerCase()).toContain(deployment.contracts.spotClobFactory.toLowerCase());
    expect(webEnvExample.toLowerCase()).toContain(deployment.contracts.spotClobLens.toLowerCase());
    expect(webEnvExample.toLowerCase()).toContain(deployment.defaultMarket.poolId.toLowerCase());
    expect(webEnvExample).toContain(`NEXT_PUBLIC_MONAD_CLOB_DEPLOYMENT_BLOCK=${deployment.deploymentBlock}`);

    if (existsSync(webEnvLocalUrl)) {
      const webEnvLocal = readFileSync(webEnvLocalUrl, "utf8").toLowerCase();
      expect(webEnvLocal).toContain(deployment.contracts.spotClobFactory.toLowerCase());
      expect(webEnvLocal).toContain(deployment.contracts.spotClobLens.toLowerCase());
      expect(webEnvLocal).toContain(deployment.defaultMarket.poolId.toLowerCase());
    }
  });
});
