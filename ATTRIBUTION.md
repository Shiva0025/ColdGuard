# Attribution

ColdGuard's source code was written for the MERNIFY hackathon, with AI coding assistance (Anthropic Claude), as the event's AI usage policy allows. It uses the open-source packages below unmodified, through npm. Exact versions are pinned in `package-lock.json`.

| Package | Version | Licence | Used for |
|---|---|---|---|
| [express](https://expressjs.com) | 5.3.0 | MIT | REST API, ingestion, static hosting |
| [socket.io](https://socket.io) / socket.io-client | 4.8.4 | MIT | Real-time rooms, agent control namespace |
| [mongodb](https://github.com/mongodb/node-mongodb-native) (Node driver) | 6.22.0 | Apache-2.0 | Persistence, aggregation |
| [MongoDB server](https://www.mongodb.com) (Docker image `mongo:8.0`) | 8.0.38 | SSPL | Database (run locally, unmodified) |
| [react](https://react.dev) / react-dom | 19.3.1 | MIT | UI |
| [react-router](https://reactrouter.com) | 7.18.5 | MIT | Client routing |
| [vite](https://vite.dev) + @vitejs/plugin-react | 7.3.8 / 5.2.0 | MIT | Dev server and build |
| [tailwindcss](https://tailwindcss.com) + @tailwindcss/vite | 4.3.5 | MIT | Styling |
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.32 | MIT | Telemetry charts. Its base CSS rules were adapted into `web/src/index.css` for the dark theme |
| [@tanstack/react-virtual](https://tanstack.com/virtual) | 3.14.26 | MIT | Virtualised shipment list |
| [lucide-react](https://lucide.dev) | 0.540.0 | ISC | Icons |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | QR code for the judges' invite |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) via @fontsource-variable/plus-jakarta-sans | 5.3.0 | OFL-1.1 | UI typeface (self-hosted) |
| [zod](https://zod.dev) | 3.25.76 | MIT | Shared validation schemas |
| [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | 3.0.3 | BSD-3-Clause | Password hashing |
| [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | 9.0.3 | MIT | JWT sessions |
| [helmet](https://helmetjs.github.io) | 8.3.0 | MIT | Security headers / CSP |
| [cors](https://github.com/expressjs/cors) | 2.8.6 | MIT | CORS allow-list |
| [dotenv](https://github.com/motdotla/dotenv) | 16.6.1 | BSD-2-Clause | Local configuration |
| [tsx](https://tsx.is) | 4.23.15 | MIT | TypeScript runtime |
| [vitest](https://vitest.dev) | 3.2.7 | MIT | Unit / integration tests |
| [@playwright/test](https://playwright.dev) | 1.55.0 | Apache-2.0 | End-to-end browser test |
| [concurrently](https://github.com/open-cli-tools/concurrently) | 9.2.5 | MIT | Running the dev processes together |
| [typescript](https://www.typescriptlang.org) | 5.9.3 | Apache-2.0 | Type checking |

## Algorithms and other resources

- **mulberry32** PRNG (public-domain snippet by Tommy Ettinger), re-implemented in `simulator/src/model.ts` for deterministic seeding.
- Box–Muller transform for Gaussian noise, and an ordinary least-squares slope for drift detection: standard formulas.
- SHA-256 hash chaining of sealed blocks (a standard tamper-evidence technique), using Node's built-in `crypto`.
- Trapezoidal integration for the heat-exposure budget; the budget idea is inspired by vaccine vial monitors (no proprietary data or method is used).
- NTP-style clock-offset estimation (offset = server − (t0 + t1)/2, using the lowest-RTT sample): standard technique.
- City coordinates are approximate public latitude/longitude values, used only to place labels on a schematic.
- No external APIs, map tiles, fonts, images or design assets are used. The favicon is an original SVG.
