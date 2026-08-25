import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { KeysProvider } from "./context/KeysContext";
import { NotFoundPage } from "./components/NotFoundPage.tsx";
import { PrivacyPage } from "./components/PrivacyPage.tsx";
import { TermsPage } from "./components/TermsPage.tsx";
import { DisclaimerPage } from "./components/DisclaimerPage.tsx";
import { AbusePolicyPage } from "./components/AbusePolicyPage.tsx";
import { ThreatModelPage } from "./components/ThreatModelPage.tsx";
import { PayPage } from "./components/PayPage.tsx";
import { PaySuccessPage } from "./components/PaySuccessPage.tsx";
import { getConfiguredNetwork, getNetworkEnvValue } from "./lib/chain.ts";
import { isClusterSupported } from "./contracts/contract-config.ts";
import { LandingPage } from "./components/LandingPage.tsx";
import { BrandingPage } from "./components/BrandingPage.tsx";
import { StellarWalletProviders } from "./context/StellarWalletProviders.tsx";
import { MainnetSecurityLayer } from "./components/security/MainnetSecurityLayer.tsx";
import { debugLog } from "./lib/debugLog";
import { logExpectedArtifactHashes } from "./lib/artifactHashes.ts";
import { THREAT_MODEL_ROUTE } from "./lib/privacyThreatModel.ts";
import { installGlobalErrorCapture } from "./lib/errorReporting.ts";
import { initCspReportCollector } from "./lib/cspReport.ts";

debugLog("[Opaque] App bootstrapping (Stellar)");
logExpectedArtifactHashes();

const network = getConfiguredNetwork();

// #560: no-op until the user opts in from Settings, and even then reports are only
// queued locally — nothing is transmitted without an explicit send.
installGlobalErrorCapture({
  network: getNetworkEnvValue(),
  appVersion: (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "dev",
});

// CSP report-only collector: logs violations in dev, forwards to VITE_CSP_REPORT_URL if set.
initCspReportCollector();

if (!isClusterSupported(network)) {
  debugLog("[Opaque] Unsupported network: %s", getNetworkEnvValue());
} else {
  debugLog("[Opaque] Network OK: %s", network);
}

function LandingRoute() {
  const navigate = useNavigate();
  return <LandingPage onEnterVault={() => navigate("/app")} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StellarWalletProviders>
      <BrowserRouter>
        <MainnetSecurityLayer />
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/app" element={<App />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/disclaimer" element={<DisclaimerPage />} />
          <Route path="/abuse-policy" element={<AbusePolicyPage />} />
          <Route path={THREAT_MODEL_ROUTE} element={<ThreatModelPage />} />
          <Route path="/pay/success" element={<PaySuccessPage />} />
          <Route
            path="/pay/:identifier"
            element={
              <KeysProvider>
                <PayPage />
              </KeysProvider>
            }
          />
          <Route path="/branding" element={<BrandingPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </StellarWalletProviders>
  </StrictMode>,
);
