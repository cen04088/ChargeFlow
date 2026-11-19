import { TDSMobileAITProvider } from "@toss/tds-mobile-ait";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import config from "../apps-in-toss.config.ts";
import App from "./App.tsx";
import "./index.css";

// iOS WebView는 터치 리스너가 없으면 :active를 늦게 적용한다 — 누르는 즉시 반응하도록 등록
document.addEventListener("touchstart", () => {}, { passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TDSMobileAITProvider brandPrimaryColor={config.brand.primaryColor}>
      <App />
    </TDSMobileAITProvider>
  </StrictMode>,
);
