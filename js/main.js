/* ============================================================
   Birigui Drone — Hero 360° (WebGL)
   Renderiza um vídeo equiretangular (MP4 360°) numa esfera, com a
   câmera controlada por:
     • giroscópio/acelerômetro no celular (funciona no iPhone!)
     • arraste (mouse/touch) no desktop
     • rotação automática lenta quando ocioso
   Como nós renderizamos (WebGL), a orientação é fisicamente correta —
   sem a limitação do 360° do YouTube no iOS.
   ============================================================ */
(function () {
  "use strict";

  // Arquivo do vídeo 360° equiretangular (em assets/). Usamos a versão H.264
  // ("-web"), que roda em qualquer iPhone (o original do YouTube é AV1 e o iOS
  // não decodifica). Se não carregar, a página mostra um padrão de teste.
  var VIDEO_SRC = "assets/alphaville-360-web.mp4?v=7";

  // ---- Ajustes ("tuning") ----------------------------------
  // Projeção: "sphere" = 360° imersivo (perspectiva) | "panorama" = plano (sem perspectiva),
  // arrasta pra passear. Troque ao vivo no console: BiriguiDebug.setMode("sphere"|"panorama").
  var MODE = "sphere";
  var PANO_VFOV_DEG = 110;   // panorama: quanto (em graus verticais) mostrar de cada vez

  // Interação: false = TOQUE/arraste na tela (pedido do cliente);
  //            true  = giroscópio do celular.
  var USE_GYRO = false;
  var DRAG_YAW = 0.22;        // graus por pixel (horizontal)
  var DRAG_PITCH = 0.22;      // graus por pixel (vertical)
  var INERTIA_DECAY = 0.94;   // atrito do "flick" (0..1); maior = desliza mais
  var AUTOROTATE_DPS = 3.0;   // graus por segundo (rotação ociosa)
  var IDLE_MS = 3500;         // tempo ocioso até voltar a autorrotacionar
  var FOV_V_DEG = 82;         // campo de visão vertical (graus)
  var DPR_CAP = 3;            // limite de devicePixelRatio (3 = nitidez nativa em iPhones)

  // ---- Estado ----------------------------------------------
  var gl, canvas, video;
  var prog, aPosLoc, uTexLoc, uRotLoc, uFovTanLoc, uAspectLoc, uModeLoc, uPanLoc, uSpanLoc;
  var texture, usingVideo = false, texReady = false;
  var raf = 0, lastTs = 0;

  var gyroActive = false, dragging = false;
  var lastX = 0, lastY = 0, lastInteraction = 0;
  var velYaw = 0, velPitch = 0, momentum = false; // inércia do arraste (flick)
  var view = { yaw: 0, pitch: 0 };          // usado no arraste/autorrotação (graus)
  var offsetQuat = { x: 0, y: 0, z: 0, w: 1 }; // recentralização do giroscópio
  var orientQuat = { x: 0, y: 0, z: 0, w: 1 }; // orientação final da câmera

  var elInteractor, elGate, elGateBtn, elHint;
  var elPreloader, elPreloaderFill, elPreloaderPct;

  // Diagnóstico (?debug=1)
  var doeCount = 0, lastOrient = null, permState = "n/a", srcInfo = "(carregando)";

  // ===========================================================
  //  Matemática (quaternions / matrizes)
  // ===========================================================
  var D2R = Math.PI / 180;
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrap360(a) { return ((a % 360) + 360) % 360; }

  function qMul(a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
    };
  }
  function qAxisAngle(x, y, z, ang) {
    var h = ang / 2, s = Math.sin(h);
    return { x: x * s, y: y * s, z: z * s, w: Math.cos(h) };
  }
  function qFromEulerYXZ(x, y, z) {
    var c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    var s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return {
      x: s1 * c2 * c3 + c1 * s2 * s3,
      y: c1 * s2 * c3 - s1 * c2 * s3,
      z: c1 * c2 * s3 - s1 * s2 * c3,
      w: c1 * c2 * c3 + s1 * s2 * s3
    };
  }
  function qNorm(q) {
    var n = 1 / (Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1);
    return { x: q.x * n, y: q.y * n, z: q.z * n, w: q.w * n };
  }
  // Matriz 3x3 (column-major) a partir de um quaternion unitário.
  function qToMat3(q) {
    var x = q.x, y = q.y, z = q.z, w = q.w;
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    return new Float32Array([
      1 - (yy + zz), xy + wz, xz - wy,
      xy - wz, 1 - (xx + zz), yz + wx,
      xz + wy, yz - wx, 1 - (xx + yy)
    ]);
  }
  function qRotateVec(q, vx, vy, vz) {
    var tx = 2 * (q.y * vz - q.z * vy),
        ty = 2 * (q.z * vx - q.x * vz),
        tz = 2 * (q.x * vy - q.y * vx);
    return [
      vx + q.w * tx + (q.y * tz - q.z * ty),
      vy + q.w * ty + (q.z * tx - q.x * tz),
      vz + q.w * tz + (q.x * ty - q.y * tx)
    ];
  }

  // Quaternion "magic window" do dispositivo (three.js DeviceOrientationControls):
  // câmera olha -Z, +Y cima. Fisicamente correto — sem ambiguidade de sinal.
  function deviceQuaternion(alpha, beta, gamma, screenAngle) {
    var q = qFromEulerYXZ(beta * D2R, alpha * D2R, -gamma * D2R);
    q = qMul(q, { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }); // -90° em X: olha pra frente
    q = qMul(q, qAxisAngle(0, 0, 1, -screenAngle * D2R));           // retrato/paisagem
    return qNorm(q);
  }
  // Orientação por yaw/pitch (arraste/autorrotação): yaw em torno de +Y, pitch em torno de +X.
  function yawPitchQuaternion(yawDeg, pitchDeg) {
    var qy = qAxisAngle(0, 1, 0, yawDeg * D2R);
    var qx = qAxisAngle(1, 0, 0, pitchDeg * D2R);
    return qNorm(qMul(qy, qx));
  }
  function headingOf(q) { // yaw (graus) da direção "forward" do quaternion
    var f = qRotateVec(q, 0, 0, -1);
    return Math.atan2(f[0], -f[2]) / D2R;
  }

  function getScreenAngle() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === "number")
      return window.screen.orientation.angle;
    if (typeof window.orientation === "number") return window.orientation;
    return 0;
  }

  // ===========================================================
  //  WebGL
  // ===========================================================
  var VERT = [
    "attribute vec2 aPos;",
    "varying vec2 vNdc;",
    "void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }"
  ].join("\n");

  var FRAG = [
    "precision highp float;",
    "varying vec2 vNdc;",
    "uniform sampler2D uTex;",
    "uniform float uMode;",   // 0 = esfera (perspectiva) | 1 = panorama (plano)
    "uniform mat3 uRot;",
    "uniform float uFovTan;",
    "uniform float uAspect;",
    "uniform vec2 uPan;",     // panorama: centro em uv
    "uniform vec2 uSpan;",    // panorama: fração de uv visível (x,y)
    "const float PI = 3.141592653589793;",
    "void main(){",
    "  vec2 uv;",
    "  if (uMode > 0.5) {",
    "    uv = vec2(uPan.x + vNdc.x * uSpan.x * 0.5, uPan.y - vNdc.y * uSpan.y * 0.5);",
    "    uv.x = fract(uv.x);",
    "    uv.y = clamp(uv.y, 0.0, 1.0);",
    "  } else {",
    "    vec3 dirCam = normalize(vec3(vNdc.x * uFovTan * uAspect, vNdc.y * uFovTan, -1.0));",
    "    vec3 dir = uRot * dirCam;",
    "    uv = vec2(fract(atan(dir.x, -dir.z) / (2.0*PI) + 0.5), clamp(0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI, 0.0, 1.0));",
    "  }",
    "  gl_FragColor = texture2D(uTex, uv);",
    "}"
  ].join("\n");

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[Birigui] shader:", gl.getShaderInfoLog(s));
    }
    return s;
  }

  function initGL() {
    gl = canvas.getContext("webgl", { antialias: true, alpha: false }) ||
         canvas.getContext("experimental-webgl", { antialias: true, alpha: false });
    if (!gl) { console.error("[Birigui] WebGL indisponível."); return false; }

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[Birigui] link:", gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);

    // Triângulo em tela cheia
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    aPosLoc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    uTexLoc = gl.getUniformLocation(prog, "uTex");
    uRotLoc = gl.getUniformLocation(prog, "uRot");
    uFovTanLoc = gl.getUniformLocation(prog, "uFovTan");
    uAspectLoc = gl.getUniformLocation(prog, "uAspect");
    uModeLoc = gl.getUniformLocation(prog, "uMode");
    uPanLoc = gl.getUniformLocation(prog, "uPan");
    uSpanLoc = gl.getUniformLocation(prog, "uSpan");

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // pixel provisório (preto) até a textura carregar
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
    gl.uniform1i(uTexLoc, 0);
    return true;
  }

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.round(canvas.clientWidth * dpr);
    var h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  // ===========================================================
  //  Textura: vídeo (preferido) ou padrão de teste (fallback)
  // ===========================================================
  function markVideoReady() {
    if (video.readyState >= 2 && video.videoWidth > 0) {
      usingVideo = true; texReady = true;
      srcInfo = VIDEO_SRC + " (" + video.videoWidth + "x" + video.videoHeight + ")";
    }
  }

  function initVideoSource() {
    useTestPattern();                 // textura de base (fica atrás do preloader)
    srcInfo = "carregando " + VIDEO_SRC + " …";
    loadVideoWithProgress(VIDEO_SRC);
  }

  function onVideoUsable() {
    markVideoReady();
    hidePreloader();
    video.play().catch(function () {}); // desktop/Android autoplaya; iOS espera o toque
  }

  // Carrega o vídeo por fetch com progresso REAL (%) e toca de um blob quando termina.
  function loadVideoWithProgress(url) {
    if (!window.fetch || !window.ReadableStream) { fallbackStreaming(url); return; }
    fetch(url).then(function (res) {
      if (!res.ok || !res.body) throw new Error("resposta inválida");
      var total = parseInt(res.headers.get("Content-Length") || "0", 10);
      var received = 0, chunks = [];
      var reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            setPreloadProgress(100);
            video.addEventListener("loadeddata", onVideoUsable, { once: true });
            video.addEventListener("canplay", onVideoUsable, { once: true });
            video.src = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
            video.load();
            return;
          }
          received += r.value.length;
          chunks.push(r.value);
          if (total) setPreloadProgress(Math.min(99, Math.round(received / total * 100)));
          return pump();
        });
      }
      return pump();
    }).catch(function () { fallbackStreaming(url); });
  }

  // Fallback: streaming direto (% aproximada pelo buffer). Esconde o preloader ao poder tocar.
  function fallbackStreaming(url) {
    video.addEventListener("progress", function () {
      try {
        if (video.buffered.length && video.duration) {
          setPreloadProgress(Math.min(99, Math.round(video.buffered.end(video.buffered.length - 1) / video.duration * 100)));
        }
      } catch (e) {}
    });
    video.addEventListener("loadeddata", onVideoUsable, { once: true });
    video.addEventListener("canplay", onVideoUsable, { once: true });
    video.addEventListener("error", function () { hidePreloader(); }, { once: true });
    video.src = url;
    video.load();
    video.play().catch(function () {});
  }

  function setPreloadProgress(p) {
    if (elPreloaderFill) elPreloaderFill.style.width = p + "%";
    if (elPreloaderPct) elPreloaderPct.textContent = p + "%";
  }
  function hidePreloader() {
    if (elPreloader) elPreloader.classList.add("is-hidden");
  }

  // Padrão equiretangular de referência (para testar sem o MP4).
  function useTestPattern() {
    usingVideo = false;
    srcInfo = "padrão de teste (sem MP4 em assets/)";
    var c = document.createElement("canvas");
    c.width = 2048; c.height = 1024;
    var x = c.getContext("2d");
    // bandas de latitude
    for (var yy = 0; yy < c.height; yy += 64) {
      var lat = 90 - (yy / c.height) * 180;
      x.fillStyle = "hsl(" + (200 + lat) + ",45%," + (18 + 22 * (1 - Math.abs(lat) / 90)) + "%)";
      x.fillRect(0, yy, c.width, 64);
    }
    // linhas de longitude
    x.strokeStyle = "rgba(120,220,255,.35)"; x.lineWidth = 2;
    for (var lon = 0; lon <= 360; lon += 30) {
      var px = (lon / 360) * c.width;
      x.beginPath(); x.moveTo(px, 0); x.lineTo(px, c.height); x.stroke();
    }
    x.strokeStyle = "rgba(255,255,255,.5)";
    x.beginPath(); x.moveTo(0, c.height / 2); x.lineTo(c.width, c.height / 2); x.stroke();
    // rótulos no equador: u=0.5 = FRENTE
    x.fillStyle = "#eaf6ff"; x.font = "bold 54px system-ui,Arial"; x.textAlign = "center";
    var labels = [["ATRÁS", 0.0], ["DIREITA", 0.25], ["FRENTE", 0.5], ["ESQUERDA", 0.75], ["ATRÁS", 1.0]];
    for (var k = 0; k < labels.length; k++) x.fillText(labels[k][0], labels[k][1] * c.width, c.height / 2 - 24);
    x.fillText("CIMA", c.width / 2, 70);
    x.fillText("BAIXO", c.width / 2, c.height - 40);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, c);
    texReady = true;
    texAllocated = false; // vídeo (tamanho diferente) precisará realocar
  }

  var texAllocated = false; // 1ª vez aloca (texImage2D); depois atualiza in-place (texSubImage2D)
  function updateTexture() {
    if (!usingVideo || video.readyState < 2) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      if (!texAllocated) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        texAllocated = true;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, video);
      }
    } catch (e) { /* frame ainda indisponível */ }
  }

  // ===========================================================
  //  Loop de renderização
  // ===========================================================
  function render(ts) {
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000; lastTs = ts;

    if (!gyroActive) {
      if (momentum && !dragging) {
        // inércia: continua girando após o "flick", desacelerando
        view.yaw = wrap360(view.yaw + velYaw);
        view.pitch = clamp(view.pitch + velPitch, -85, 85);
        velYaw *= INERTIA_DECAY; velPitch *= INERTIA_DECAY;
        lastInteraction = ts; // segura a autorrotação enquanto desliza
        if (Math.abs(velYaw) < 0.02 && Math.abs(velPitch) < 0.02) { momentum = false; velYaw = velPitch = 0; }
      } else if (!dragging && (ts - lastInteraction) > IDLE_MS) {
        view.yaw = wrap360(view.yaw + AUTOROTATE_DPS * dt);
      }
      orientQuat = yawPitchQuaternion(view.yaw, view.pitch);
    }

    resize();
    if (usingVideo) updateTexture();

    gl.useProgram(prog);
    var aspect = canvas.width / canvas.height;
    if (MODE === "panorama") {
      gl.uniform1f(uModeLoc, 1.0);
      // "sem esticar": pixels quadrados -> span horizontal = vertical * aspect
      var spanV = clamp(PANO_VFOV_DEG / 180, 0.02, 1.0);
      var spanU = (PANO_VFOV_DEG * aspect) / 360;
      var half = spanV / 2;
      gl.uniform2f(uPanLoc, wrap360(view.yaw) / 360, clamp(0.5 - view.pitch / 180, half, 1 - half));
      gl.uniform2f(uSpanLoc, spanU, spanV);
    } else {
      gl.uniform1f(uModeLoc, 0.0);
      gl.uniformMatrix3fv(uRotLoc, false, qToMat3(orientQuat));
      gl.uniform1f(uFovTanLoc, Math.tan((FOV_V_DEG * D2R) / 2));
      gl.uniform1f(uAspectLoc, aspect);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    raf = requestAnimationFrame(render);
  }

  // ===========================================================
  //  Arraste (desktop / fallback)
  // ===========================================================
  function bindDrag() {
    elInteractor.addEventListener("pointerdown", function (e) {
      dragging = true; gyroActive = false; momentum = false;
      velYaw = 0; velPitch = 0;
      elInteractor.classList.add("is-dragging");
      try { elInteractor.setPointerCapture(e.pointerId); } catch (er) {}
      lastX = e.clientX; lastY = e.clientY;
      lastInteraction = performance.now();
    });
    elInteractor.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      var dYaw = dx * DRAG_YAW, dPitch = dy * DRAG_PITCH;
      // "pega o mundo": arrasta p/ direita -> olha p/ esquerda; p/ baixo -> olha p/ cima
      view.yaw = wrap360(view.yaw + dYaw);
      view.pitch = clamp(view.pitch + dPitch, -85, 85);
      velYaw = dYaw; velPitch = dPitch; // guarda p/ inércia ao soltar
      lastInteraction = performance.now();
    });
    function end() {
      dragging = false;
      elInteractor.classList.remove("is-dragging");
      momentum = (Math.abs(velYaw) > 0.05 || Math.abs(velPitch) > 0.05);
      lastInteraction = performance.now();
    }
    elInteractor.addEventListener("pointerup", end);
    elInteractor.addEventListener("pointercancel", end);
    elInteractor.addEventListener("pointerleave", function () { if (dragging) end(); });
    elInteractor.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }

  // ===========================================================
  //  Giroscópio + portão de entrada
  // ===========================================================
  function onDeviceOrientation(e) {
    doeCount++;
    lastOrient = { a: e.alpha, b: e.beta, g: e.gamma };
    if (e.alpha === null && e.beta === null && e.gamma === null) return;
    gyroActive = true;
    var dq = deviceQuaternion(e.alpha || 0, e.beta || 0, e.gamma || 0, getScreenAngle());
    orientQuat = qMul(offsetQuat, dq);   // aplica recentralização de yaw
    lastInteraction = performance.now();
    hideHint();
  }

  function recenter() {
    // faz a direção atual virar a "frente" (u=0.5) do vídeo
    var h = headingOf(orientQuat);
    offsetQuat = qMul(qAxisAngle(0, 1, 0, -h * D2R), offsetQuat);
  }

  function enableMotion() {
    var DOE = window.DeviceOrientationEvent;
    if (!DOE) { permState = "sem-sensor"; return Promise.resolve(false); }
    if (typeof DOE.requestPermission === "function") {
      return DOE.requestPermission().then(function (res) {
        permState = res;
        if (res === "granted") { window.addEventListener("deviceorientation", onDeviceOrientation, true); return true; }
        return false;
      }).catch(function (err) { permState = "erro:" + (err && err.name || err); return false; });
    }
    permState = "auto (sem prompt)";
    window.addEventListener("deviceorientation", onDeviceOrientation, true);
    return Promise.resolve(true);
  }

  function enterExperience() {
    if (video) { video.muted = true; video.play().catch(function () {}); }
    if (USE_GYRO) enableMotion(); // desligado: interação por toque/arraste
    hideGate();
  }

  function hideGate() { if (elGate) elGate.classList.add("is-hidden"); }
  function hideHint() { if (elHint) elHint.classList.add("is-hidden"); }

  // ===========================================================
  //  Painel de diagnóstico (?debug=1)
  // ===========================================================
  function initDebugOverlay() {
    var box = document.createElement("div");
    box.id = "biriguiDebug";
    box.style.cssText =
      "position:fixed;left:8px;top:8px;z-index:99999;max-width:88vw;" +
      "font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#d8faff;" +
      "background:rgba(0,10,18,.85);border:1px solid rgba(120,220,255,.4);" +
      "border-radius:10px;padding:9px 11px;white-space:pre;pointer-events:none;" +
      "-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);";
    document.body.appendChild(box);
    function f(n) { return (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : String(n); }
    setInterval(function () {
      var lo = lastOrient;
      var hasReq = window.DeviceOrientationEvent &&
        typeof window.DeviceOrientationEvent.requestPermission === "function";
      var fwd = qRotateVec(orientQuat, 0, 0, -1);
      box.textContent =
        "BIRIGUI · diagnóstico (WebGL)\n" +
        "textura: " + srcInfo + "\n" +
        "vídeo: rs=" + (video ? video.readyState : "-") + " t=" + (video ? f(video.currentTime) : "-") + "\n" +
        "HTTPS/secure: " + (window.isSecureContext ? "sim" : "NÃO") + "\n" +
        "requestPermission: " + (hasReq ? "iOS (sim)" : "não (Android/desktop)") + "\n" +
        "permissão: " + permState + "\n" +
        "eventos sensor: " + doeCount + (lo ? ("  a=" + f(lo.a) + " b=" + f(lo.b) + " g=" + f(lo.g)) : "  (nenhum)") + "\n" +
        "tela angle: " + getScreenAngle() + "   gyroAtivo: " + gyroActive + "\n" +
        "olhar(yaw/pitch): " + f(Math.atan2(fwd[0], -fwd[2]) / D2R) + " / " + f(Math.asin(clamp(fwd[1], -1, 1)) / D2R);
    }, 250);
  }

  // ===========================================================
  //  Boot
  // ===========================================================
  function init() {
    canvas = document.getElementById("gl");
    video = document.getElementById("video");
    elInteractor = document.getElementById("interactor");
    elGate = document.getElementById("gate");
    elGateBtn = document.getElementById("gateBtn");
    elHint = document.getElementById("hint");
    elPreloader = document.getElementById("preloader");
    elPreloaderFill = document.getElementById("preloaderFill");
    elPreloaderPct = document.getElementById("preloaderPct");

    if (!initGL()) return;

    // vídeo mudo/inline (autoplay em mobile)
    video.muted = true;
    video.setAttribute("muted", "");
    video.setAttribute("webkit-playsinline", "");
    video.playsInline = true;

    bindDrag();
    if (elGateBtn) elGateBtn.addEventListener("click", enterExperience);

    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", function () { setTimeout(resize, 200); });

    if (/[?&]debug\b/.test(location.search)) initDebugOverlay();

    // hook de debug/calibração
    window.BiriguiDebug = {
      recenter: recenter,
      view: view,
      usingVideo: function () { return usingVideo; },
      forward: function () { return qRotateVec(orientQuat, 0, 0, -1); },
      state: function () { return { gyroActive: gyroActive, dragging: dragging, momentum: momentum, velYaw: velYaw, velPitch: velPitch }; },
      setMode: function (m) { MODE = (m === "panorama") ? "panorama" : "sphere"; return MODE; },
      getMode: function () { return MODE; },
      setPanoFov: function (deg) { PANO_VFOV_DEG = deg; return PANO_VFOV_DEG; },
      video: video
    };

    initVideoSource();
    raf = requestAnimationFrame(render);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
