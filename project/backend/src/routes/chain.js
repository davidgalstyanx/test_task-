const { randomUUID } = require("crypto");
const { Router } = require("express");
const { z } = require("zod");
const {
  acquireLicenseOnChain,
  buildAcquireTxRequest,
  buildListTxRequest,
  chainConfig,
  getChainStatus,
  getOnChainListing,
  listModelOnChain,
} = require("../chain/marketplace");
const { findModel, shortAddress, store } = require("../data/store");
const { optionalAuth } = require("../middleware/auth");

const chainRouter = Router();

chainRouter.get("/status", async (_req, res) => {
  const status = await getChainStatus();
  res.json({
    ...status,
    config: {
      marketplace: chainConfig.marketplace,
      chainId: chainConfig.chainId,
      rpcUrl: chainConfig.rpcUrl,
    },
  });
});

chainRouter.get("/config", (_req, res) => {
  res.json({
    marketplace: chainConfig.marketplace,
    chainId: chainConfig.chainId,
    rpcUrl: chainConfig.rpcUrl,
    abi: chainConfig.abi,
  });
});

chainRouter.get("/listing/:slug", async (req, res) => {
  try {
    const listing = await getOnChainListing(req.params.slug);
    if (!listing) {
      res.status(404).json({ error: "NotFound", message: "No on-chain listing" });
      return;
    }
    res.json({ listing });
  } catch (error) {
    res.status(503).json({
      error: "ChainUnavailable",
      message: error instanceof Error ? error.message : "RPC error",
    });
  }
});

const listSchema = z.object({
  mode: z.enum(["relay", "tx", "confirm"]).default("relay"),
  txHash: z.string().optional(),
  walletAddress: z.string().optional(),
});

chainRouter.post("/list/:slug", optionalAuth, async (req, res) => {
  const model = findModel(req.params.slug);
  if (!model) {
    res.status(404).json({ error: "NotFound", message: "Model not found in API" });
    return;
  }

  const parsed = listSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "ValidationError", details: parsed.error.flatten() });
    return;
  }

  const mode = req.query.mode === "tx" ? "tx" : parsed.data.mode;
  const metadataURI = `https://NuvyraHub.local/metadata/${model.slug}.json`;

  try {
    if (mode === "tx") {
      const tx = buildListTxRequest({
        slug: model.slug,
        metadataURI,
        priceEth: model.priceEth,
        royaltyBps: 500,
      });
      res.json({ mode: "tx", tx, model });
      return;
    }

    if (mode === "confirm") {
      if (!parsed.data.txHash) {
        res.status(400).json({ error: "ValidationError", message: "txHash required" });
        return;
      }

      const listing = await getOnChainListing(model.slug);
      if (!listing) {
        res.status(404).json({
          error: "NotListedOnChain",
          message: "No listing found on-chain for this slug yet",
        });
        return;
      }

      const creator = listing.creator || parsed.data.walletAddress;
      model.walletAddress = creator;
      model.address = shortAddress(creator);
      model.listingMode = "wallet";
      model.status = "Active";
      model.onChain = {
        tokenId: listing.tokenId,
        creator,
        txHash: parsed.data.txHash,
        listedBy: "wallet",
        listedAt: new Date().toISOString(),
      };
      model.updatedAt = new Date().toISOString();

      if (req.user) req.user.walletAddress = creator;

      res.status(201).json({ mode: "confirm", listing, model });
      return;
    }

    const result = await listModelOnChain({
      slug: model.slug,
      metadataURI,
      priceEth: model.priceEth,
      royaltyBps: 500,
    });
    if (result?.listing) {
      model.onChain = {
        tokenId: result.listing.tokenId,
        creator: result.listing.creator,
        txHash: result.txHash,
        listedBy: "deployer",
        listedAt: new Date().toISOString(),
      };
    }
    res.status(201).json({ mode: "relay", ...result, model });
  } catch (error) {
    res.status(500).json({
      error: "ListFailed",
      message: error instanceof Error ? error.message : "List failed",
    });
  }
});

const acquireSchema = z.object({
  mode: z.enum(["relay", "tx", "confirm"]).default("relay"),
  txHash: z.string().optional(),
  walletAddress: z.string().optional(),
});

chainRouter.post("/acquire/:slug", optionalAuth, async (req, res) => {
  const model = findModel(req.params.slug);
  if (!model) {
    res.status(404).json({ error: "NotFound", message: "Model not found" });
    return;
  }

  const parsed = acquireSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "ValidationError", details: parsed.error.flatten() });
    return;
  }

  try {
    const listing = await getOnChainListing(model.slug);
    if (!listing) {
      res.status(404).json({
        error: "NotListedOnChain",
        message: "Model is not listed on-chain yet. Call POST /api/chain/list/:slug first.",
      });
      return;
    }

    if (parsed.data.mode === "tx") {
      res.json({
        mode: "tx",
        listing,
        tx: buildAcquireTxRequest(listing),
      });
      return;
    }

    if (parsed.data.mode === "confirm") {
      if (!parsed.data.txHash) {
        res.status(400).json({ error: "ValidationError", message: "txHash required" });
        return;
      }
      const acquisition = {
        id: randomUUID(),
        modelSlug: model.slug,
        userId: req.user?.id || "wallet-user",
        walletAddress: parsed.data.walletAddress || "unknown",
        priceEth: model.priceEth,
        txHash: parsed.data.txHash,
        createdAt: new Date().toISOString(),
        onChain: true,
      };
      store.acquisitions.push(acquisition);
      res.status(201).json({ mode: "confirm", acquisition, listing, model });
      return;
    }

    // relay: backend signer pays/acquires (demo)
    const result = await acquireLicenseOnChain(model.slug);
    const acquisition = {
      id: randomUUID(),
      modelSlug: model.slug,
      userId: req.user?.id || "relay-buyer",
      walletAddress: result.buyer,
      priceEth: model.priceEth,
      txHash: result.txHash || `already-owned:${result.buyer}`,
      createdAt: new Date().toISOString(),
      onChain: true,
    };
    store.acquisitions.push(acquisition);
    model.downloadsCount += result.alreadyOwned ? 0 : 1;
    res.status(201).json({
      mode: "relay",
      ...result,
      acquisition,
      model,
      message: result.alreadyOwned
        ? "Wallet already holds license"
        : "License acquired on-chain",
    });
  } catch (error) {
    res.status(500).json({
      error: "AcquireFailed",
      message: error instanceof Error ? error.message : "Acquire failed",
    });
  }
});

module.exports = { chainRouter };
