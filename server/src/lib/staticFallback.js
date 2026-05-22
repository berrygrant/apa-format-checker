export const BACKEND_ONLY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>APA Review API</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f3ec;
        color: #1f2a2c;
      }
      main {
        max-width: 760px;
        margin: 56px auto;
        padding: 0 24px;
      }
      .card {
        background: white;
        border: 1px solid rgba(31, 42, 44, 0.12);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 16px 48px rgba(31, 42, 44, 0.08);
      }
      code {
        background: #eef3f2;
        border-radius: 6px;
        padding: 2px 6px;
      }
      ul {
        line-height: 1.7;
      }
      a {
        color: #0f766e;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>APA Review backend is running</h1>
        <p>The React frontend has not been built yet, so this server cannot serve the web app from <code>/</code>.</p>
        <ul>
          <li>For local development, run the Vite client and open <a href="http://localhost:5173">http://localhost:5173</a>.</li>
          <li>To serve everything from this Express server, build the client so <code>client/dist</code> exists.</li>
          <li>API health check: <a href="/api/health">/api/health</a></li>
        </ul>
      </div>
    </main>
  </body>
</html>`;
