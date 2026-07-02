const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  addCustomItem,
  createBuild,
  deleteBuild,
  deleteCustomItem,
  deleteInstance,
  disableCustomItem,
  getBuildDownload,
  getDashboard,
  refreshDiffs,
  saveCapabilityPackage,
  saveExporter,
  saveInstance,
  selectExporter,
  syncExporterCatalog,
  updateBuildTags,
  uploadOfficialVersion
} = require("./platform");
const { ensureStore, loadState } = require("./store");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(process.cwd(), "public");

ensureStore();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, loadState());
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      return json(res, getDashboard());
    }
    if (req.method === "POST" && url.pathname === "/api/catalog/sync") {
      return json(res, await syncExporterCatalog());
    }
    if (req.method === "POST" && url.pathname === "/api/exporter/save") {
      return json(res, saveExporter(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/exporter/select") {
      const body = await readBody(req);
      return json(res, selectExporter(body.id));
    }
    if (req.method === "POST" && (url.pathname === "/api/catalog/upload" || url.pathname === "/api/official/upload")) {
      return json(res, uploadOfficialVersion(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/custom/add") {
      return json(res, addCustomItem(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/capability/save") {
      return json(res, saveCapabilityPackage(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/custom/disable") {
      const body = await readBody(req);
      return json(res, disableCustomItem(body.id));
    }
    if (req.method === "POST" && url.pathname === "/api/custom/delete") {
      const body = await readBody(req);
      return json(res, deleteCustomItem(body.id));
    }
    if (req.method === "POST" && url.pathname === "/api/diff/refresh") {
      return json(res, refreshDiffs());
    }
    if (req.method === "POST" && url.pathname === "/api/build") {
      return json(res, createBuild(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/build/delete") {
      const body = await readBody(req);
      return json(res, deleteBuild(body.id || body.buildId));
    }
    if (req.method === "POST" && url.pathname === "/api/build/tags") {
      return json(res, updateBuildTags(await readBody(req)));
    }
    if (req.method === "GET" && url.pathname === "/api/build/download") {
      const payload = getBuildDownload(url.searchParams.get("buildId"), url.searchParams.get("file"));
      res.writeHead(200, {
        "content-type": payload.contentType,
        "content-disposition": `attachment; filename="${payload.fileName}"`
      });
      res.end(payload.content);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/instance/save") {
      return json(res, saveInstance(await readBody(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/instance/delete") {
      const body = await readBody(req);
      return json(res, deleteInstance(body.id));
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    return json(res, { error: error.message }, 400);
  }
});

server.listen(PORT, () => {
  console.log(`Exporter manager listening on http://localhost:${PORT}`);
});

function serveStatic(route, res) {
  const safeRoute = route === "/" ? "/index.html" : route;
  const target = path.resolve(PUBLIC_DIR, `.${safeRoute}`);
  if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(target);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  fs.createReadStream(target).pipe(res);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
