import express from "express";
import { tollway, coinbaseFacilitator } from "@tollway/gate";

const app = express();

app.use(
  "/v1/report",
  tollway({
    price: "$0.004",
    network: "base-sepolia",
    payTo: process.env.TW_ADDRESS,
    facilitator: coinbaseFacilitator(),
    onEvent: (event) => console.log(event.type, event.data),
  }),
);

app.get("/v1/report", (_req, res) => {
  res.json({ report: "the paid content", generatedAt: new Date().toISOString() });
});

app.listen(3000, () => console.log("paid route: http://localhost:3000/v1/report"));
