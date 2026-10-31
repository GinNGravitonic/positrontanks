/**
 * Browser entry point: makes the client's services from the browser's
 * fetch, localStorage and history, and mounts the App into index.html's #root.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { browserHistory } from "./router.js";
import { createServices } from "./services.js";
import "./styles.css";

const services = createServices({
  fetch: window.fetch.bind(window),
  storage: window.localStorage,
  history: browserHistory(window),
});

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
