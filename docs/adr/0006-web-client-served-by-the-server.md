# A web client, served by the server under /play

The frontend is a browser single-page app (`packages/web`, React and Vite, drawing on Canvas 2D) that the existing server serves as static files under `/play/`, from the same origin and the same Docker image as the API. We chose the browser because the engine, language and Ruleset packages are plain TypeScript that runs there unchanged, and a Map's coordinates already match SVG's. We chose to serve it from the server because the deployment is deliberately one image and one task (ADR-0003): same-origin needs no CORS, and there is nothing new to deploy.

## Considered Options

- **A separate static host (S3 and CloudFront)**: rejected. It is a second deployment, and the API would need CORS.
- **A desktop app (Electron or Tauri)**: rejected. It has to be installed, with no gain over a browser for an overhead 2D view.
- **Moving the API under `/api` to free the root for the client**: rejected. It would break the CLI and every agent already using the API.

## Consequences

- Client and server ship together, so a client never meets a server it was not built with. The build relies on this: a test fails if any Ruleset the server hosts has no viewer for its engine, so every Game that can be played can also be watched ([frontend.md section 3](../spec/frontend.md#3-rulesets)).
- The server's `/play/*` paths are reserved for the client, with a fallback to its `index.html`.
- A deploy updates the client and the API at once, with the same short outage (ADR-0003).
