import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ChatsProvider } from "./lib/chats";
import { MeProvider } from "./lib/me";
import { ThemeProvider } from "./lib/theme";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <MeProvider>
          <ChatsProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ChatsProvider>
        </MeProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
