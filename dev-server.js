// Servidor estático mínimo com suporte a HTTP Range Requests.
// Segue o mesmo padrão dos outros projetos.
//
// EXTRA: o controle por giroscópio (DeviceOrientation) só funciona em
// "secure context". http://localhost conta como seguro, então no PC funciona.
// Para testar no CELULAR você precisa de HTTPS. Se existirem os arquivos de
// certificado (cert.pem/key.pem OU localhost.pem/localhost-key.pem do mkcert),
// este servidor sobe automaticamente em HTTPS. Senão, sobe em HTTP.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function handler(req, res) {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";

    // Evita path traversal
    const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      const total = stat.size;
      const range = req.headers.range;

      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        let start = match && match[1] ? parseInt(match[1], 10) : 0;
        let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
          return;
        }
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": type,
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": total,
          "Content-Type": type,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(filePath).pipe(res);
      }
    });
  } catch (e) {
    res.writeHead(500).end("Server error");
  }
}

// Procura certificados para servir em HTTPS (necessário pra testar giroscópio no celular).
function findCert() {
  const pairs = [
    ["cert.pem", "key.pem"],
    ["localhost.pem", "localhost-key.pem"],
  ];
  for (const [c, k] of pairs) {
    const cp = path.join(ROOT, c);
    const kp = path.join(ROOT, k);
    if (fs.existsSync(cp) && fs.existsSync(kp)) {
      return { cert: fs.readFileSync(cp), key: fs.readFileSync(kp) };
    }
  }
  return null;
}

function lanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const cred = findCert();
const scheme = cred ? "https" : "http";
const server = cred ? https.createServer(cred, handler) : http.createServer(handler);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Birigui Drone — servidor rodando (${scheme.toUpperCase()})`);
  console.log(`  Local:   ${scheme}://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  Rede:    ${scheme}://${ip}:${PORT}   <- abra no celular`);
  if (!cred) {
    console.log(`\n  [!] Rodando em HTTP. O giroscopio funciona no PC (localhost),`);
    console.log(`      mas NO CELULAR precisa de HTTPS. Veja o README para ativar.`);
  }
  console.log("");
});
