import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import QRCode from "qrcode";

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";

// ======================================
// 🔒 PROTEÇÃO
// ======================================
process.on("unhandledRejection", err => {
  console.error("❌ Unhandled Rejection:", err);
});

process.on("uncaughtException", err => {
  console.error("❌ Uncaught Exception:", err);
});

// ======================================
// 🔧 SETUP
// ======================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ multer corrigido
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

let sock;
let ultimoQRCode = null;
let whatsappStatus = "desconectado";
let gruposDisponiveis = [];
let envioAtivo = false;

const reconnectDelay = 5000;

// ======================================
// 📁 ARQUIVOS
// ======================================
const configPath = path.join(__dirname, "respostas.json");
const leadsPath = path.join(__dirname, "leads.json");
const funilStatePath = path.join(__dirname, "funil_state.json");

if (!fs.existsSync(configPath)) {
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ativo: true,

        privado: {
          gatilhos: ["oi"],
          resposta: "Olá!"
        },

        grupo: {
          gatilhos: ["menu"],
          resposta: "Nosso menu..."
        },

        funil: {
          ativo: true,

          gatilhos: [
            "tenho interesse",
            "quero saber",
            "me chama",
            "como funciona",
            "quero",
            "interesse"
          ],

          respostas_positivas: [
            "sim",
            "quero",
            "claro",
            "continua",
            "continue",
            "positivo",
            "ok"
          ],

          etapas: [
            {
              mensagem: "Olá {{nome}}, vi que você tem interesse 👀",
              delay: 2,
              esperarResposta: true
            },
            {
              mensagem: "Posso te explicar rapidamente como funciona.",
              delay: 3,
              esperarResposta: true
            },
            {
              mensagem: "Aqui está a oferta 🔥",
              delay: 3,
              esperarResposta: false
            }
          ]
        }
      },
      null,
      2
    )
  );
}

if (!fs.existsSync(leadsPath)) {
  fs.writeFileSync(leadsPath, JSON.stringify([], null, 2));
}

if (!fs.existsSync(funilStatePath)) {
  fs.writeFileSync(funilStatePath, JSON.stringify({}, null, 2));
}

// ======================================
// 🔧 HELPERS
// ======================================
const delay = ms => new Promise(res => setTimeout(res, ms));

function delayHumano(base = 2000) {
  return base + Math.floor(Math.random() * 3000);
}

function getTextMessage(msg) {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    ""
  );
}

function salvarEstadoFunil(data) {
  fs.writeFileSync(funilStatePath, JSON.stringify(data, null, 2));
}

function carregarEstadoFunil() {
  return JSON.parse(fs.readFileSync(funilStatePath, "utf8"));
}

function contemGatilho(texto, gatilhos = []) {
  texto = texto.toLowerCase();

  return gatilhos.some(g =>
    texto.includes(g.toLowerCase())
  );
}

// ======================================
// 📲 WHATSAPP
// ======================================
async function startWhatsApp() {

  const { state, saveCreds } =
    await useMultiFileAuthState("./auth");

  const { version } =
    await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"],
    printQRInTerminal: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({
    connection,
    lastDisconnect,
    qr
  }) => {

    if (qr) {
      ultimoQRCode = qr;
      console.log("📲 QR gerado");
    }

    if (connection === "open") {

      whatsappStatus = "conectado";

      console.log("✅ WhatsApp conectado");

      try {

        await delay(3000);

        const grupos =
          await sock.groupFetchAllParticipating();

        gruposDisponiveis =
          Object.values(grupos).map(g => ({
            id: g.id,
            nome: g.subject
          }));

        console.log(
          `📌 ${gruposDisponiveis.length} grupos carregados`
        );

      } catch (err) {
        console.error(
          "❌ Erro ao carregar grupos:",
          err.message
        );
      }
    }

    if (connection === "close") {

      whatsappStatus = "desconectado";

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Logout detectado");
        return;
      }

      console.log("⚠️ Reconectando...");

      setTimeout(() => {
        startWhatsApp();
      }, reconnectDelay);
    }
  });

  // ======================================
  // 🤖 MENSAGENS
  // ======================================
  sock.ev.on("messages.upsert", async ({ messages }) => {

    try {

      const msg = messages[0];

      if (!msg?.message) return;

      const numero = msg.key.remoteJid;

      if (!numero) return;

      if (msg.key.fromMe) return;

      const texto =
        getTextMessage(msg.message).toLowerCase().trim();

      if (!texto) return;

      const config =
        JSON.parse(fs.readFileSync(configPath, "utf8"));

      if (!config.ativo) return;

      const isGrupo = numero.endsWith("@g.us");

      // ======================================
      // 🚀 FUNIL
      // ======================================

      if (!isGrupo && config.funil?.ativo) {

        const estados = carregarEstadoFunil();

        // ======================================
        // 🔥 LEAD NOVO
        // ======================================

        if (
          contemGatilho(
            texto,
            config.funil.gatilhos
          )
        ) {

          if (!estados[numero]) {

            const nome =
              msg.pushName ||
              numero.split("@")[0];

            estados[numero] = {
              etapaAtual: 0,
              aguardandoResposta: false,
              nome
            };

            salvarEstadoFunil(estados);

            console.log("🚀 Funil iniciado:", numero);

            await executarEtapa(numero);

            return;
          }
        }

        // ======================================
        // 🔥 RESPOSTA POSITIVA
        // ======================================

        if (
          estados[numero]?.aguardandoResposta
        ) {

          if (
            contemGatilho(
              texto,
              config.funil.respostas_positivas
            )
          ) {

            estados[numero].aguardandoResposta = false;

            salvarEstadoFunil(estados);

            console.log(
              "✅ Resposta positiva:",
              numero
            );

            await executarEtapa(numero);

            return;
          }
        }
      }

      // ======================================
      // 💬 RESPOSTAS SIMPLES
      // ======================================

      const regra = isGrupo
        ? config.grupo
        : config.privado;

      if (
        contemGatilho(
          texto,
          regra.gatilhos || []
        )
      ) {

        await sock.sendMessage(numero, {
          text: regra.resposta
        });
      }

    } catch (err) {
      console.error("❌ Erro mensagens:", err);
    }
  });
}

// ======================================
// 🚀 EXECUTAR ETAPA
// ======================================
async function executarEtapa(numero) {

  const estados = carregarEstadoFunil();

  const config =
    JSON.parse(fs.readFileSync(configPath, "utf8"));

  const lead = estados[numero];

  if (!lead) return;

  // ✅ trava anti duplicação
  if (lead.processando) return;

  const etapa =
    config.funil.etapas[lead.etapaAtual];

  if (!etapa) {

    delete estados[numero];

    salvarEstadoFunil(estados);

    console.log("🏁 Funil finalizado:", numero);

    return;
  }

  // ✅ ativa trava
  lead.processando = true;

  salvarEstadoFunil(estados);

  await delay(
    delayHumano((etapa.delay || 2) * 1000)
  );

  let mensagem = etapa.mensagem
    .replace(/{{nome}}/gi, lead.nome)
    .replace(
      /{{numero}}/gi,
      numero.replace("@s.whatsapp.net", "")
    );

  try {

    await sock.sendMessage(numero, {
      text: mensagem
    });

    console.log(
      `📩 Etapa ${lead.etapaAtual + 1} enviada`
    );

    lead.etapaAtual++;

    // ✅ libera trava
    lead.processando = false;

    if (etapa.esperarResposta) {

      lead.aguardandoResposta = true;

    } else {

      lead.aguardandoResposta = false;
    }

    salvarEstadoFunil(estados);

    // ✅ segue automático com proteção
    if (!etapa.esperarResposta) {

      setTimeout(() => {
        executarEtapa(numero);
      }, 1500);
    }

  } catch (err) {

    // ✅ libera trava em caso de erro
    lead.processando = false;

    salvarEstadoFunil(estados);

    console.error("❌ Erro etapa:", err.message);
  }
}

// ======================================
// 📩 ENVIO EM MASSA
// ======================================
async function escalonarEnvio(
  grupos,
  mensagem,
  tempo,
  imagem
) {

  if (!envioAtivo) return;

  const gruposValidos =
    grupos.filter(g =>
      g &&
      g.endsWith("@g.us")
    );

  if (!gruposValidos.length) {
    console.log("❌ Nenhum grupo válido");
    return;
  }

  const duracao =
    tempo === "60"
      ? 3600000
      : 1800000;

  const intervalo =
    Math.floor(duracao / gruposValidos.length);

  console.log(
    `🚀 Iniciando envio para ${gruposValidos.length} grupos`
  );

  for (let i = 0; i < gruposValidos.length; i++) {

    if (!envioAtivo) break;

    const grupo = gruposValidos[i];

    try {

      if (imagem) {

        await sock.sendMessage(grupo, {
          image: fs.readFileSync(imagem),
          caption: mensagem
        });

      } else {

        await sock.sendMessage(grupo, {
          text: mensagem
        });
      }

      console.log(
        `✅ ${i + 1}/${gruposValidos.length} enviado`
      );

    } catch (err) {

      console.error(
        `❌ Erro grupo ${grupo}:`,
        err.message
      );
    }

    if (i < gruposValidos.length - 1) {
      await delay(intervalo);
    }
  }

  console.log("🏁 Envio finalizado");
}

// ======================================
// 🌐 ROTAS
// ======================================

app.get("/verificar", (req, res) => {
  res.json({
    status: whatsappStatus
  });
});

app.get("/grupos", (req, res) => {
  res.json(gruposDisponiveis);
});

// ======================================
// 📋 EXTRAIR CONTATOS
// ======================================
app.get("/api/extrair/:grupoId", async (req, res) => {

  try {

    const grupoId = req.params.grupoId;

    const metadata =
      await sock.groupMetadata(grupoId);

    if (!metadata?.participants) {

      return res.status(400).json({
        erro: "Grupo sem participantes"
      });
    }

    const contatos =
      metadata.participants.map(p => ({

        nome:
          p.notify ||
          p.verifiedName ||
          p.id.split("@")[0],

        numero:
          p.id.replace("@s.whatsapp.net", "")
      }));

    res.json({
      sucesso: true,
      contatos
    });

  } catch (err) {

    console.error("❌ Erro extrair:", err);

    res.status(500).json({
      erro: err.message
    });
  }
});

// ======================================
// 📨 ENVIAR PRIVADO
// ======================================
app.post("/api/enviar", async (req, res) => {
  try {
    const contatos = req.body.contatos || [];
    const mensagem = req.body.mensagem || "";

    if (!contatos.length) {
      return res.status(400).json({ erro: "Nenhum contato enviado" });
    }

    let enviados = 0;
    let erros = 0;
    let ignorados = 0;

    let enviadosNoCiclo = 0;

    console.log(`🚀 Iniciando envio PRO para ${contatos.length} contatos`);

    // 🔥 Delay humano real
    function delayHumano() {
      return 8000 + Math.floor(Math.random() * 17000); // 8s a 25s
    }

    for (const contato of contatos) {

      // =============================
      // 🔒 PROTEÇÃO CONEXÃO
      // =============================
      if (whatsappStatus !== "conectado") {
        console.log("⚠️ WhatsApp desconectado, aguardando reconexão...");
        await delay(15000);
        continue;
      }

      // =============================
      // 🚫 FILTRO DE CONTATO INVÁLIDO
      // =============================
      if (
        !contato.numero ||
        contato.numero.includes("@lid") ||
        contato.numero.length < 10
      ) {
        console.log("⛔ Ignorado (inválido):", contato.numero);
        ignorados++;
        continue;
      }

      const jid = contato.numero + "@s.whatsapp.net";

      // =============================
      // 🛑 LIMITE POR HORA
      // =============================
      if (enviadosNoCiclo >= 10) {
        console.log("⏳ Limite de 10 atingido. Pausando 1 hora...");
        await delay(60 * 60 * 1000);
        enviadosNoCiclo = 0;
      }

      try {

        // =============================
        // ✍️ SIMULA DIGITAÇÃO
        // =============================
        await sock.sendPresenceUpdate("composing", jid);
        await delay(2000 + Math.random() * 3000);

        // =============================
        // 📩 ENVIO
        // =============================
        await sock.sendMessage(jid, { text: mensagem });

        console.log(`✅ Enviado para: ${contato.numero}`);

        enviados++;
        enviadosNoCiclo++;

      } catch (err) {

        console.log(`❌ Erro ao enviar para ${contato.numero}`);

        erros++;

        // =============================
        // 🔁 RETRY INTELIGENTE
        // =============================
        try {
          console.log("🔁 Tentando novamente...");
          await delay(5000);

          await sock.sendMessage(jid, { text: mensagem });

          console.log(`✅ Retry funcionou: ${contato.numero}`);

          enviados++;
          enviadosNoCiclo++;

        } catch (err2) {
          console.log(`❌ Falha definitiva: ${contato.numero}`);
        }
      }

      // =============================
      // ⏱️ DELAY HUMANO
      // =============================
      await delay(delayHumano());
    }

    console.log("🏁 Envio finalizado");

    res.json({
      sucesso: true,
      enviados,
      erros,
      ignorados
    });

  } catch (err) {
    console.error("❌ Erro geral:", err);

    res.status(500).json({
      erro: err.message
    });
  }
});

// ======================================
// 💾 SALVAR CONTATOS
// ======================================
app.post("/api/salvar", (req, res) => {

  try {

    const contatos =
      req.body.contatos || [];

    const contatosPath =
      path.join(__dirname, "contatos.json");

    let atuais = [];

    if (fs.existsSync(contatosPath)) {

      atuais = JSON.parse(
        fs.readFileSync(contatosPath, "utf8")
      );
    }

    const novos = [
      ...atuais,
      ...contatos
    ];

    fs.writeFileSync(
      contatosPath,
      JSON.stringify(novos, null, 2)
    );

    res.json({
      sucesso: true,
      salvos: contatos.length
    });

  } catch (err) {

    console.error("❌ Erro salvar:", err);

    res.status(500).json({
      erro: err.message
    });
  }
});

app.get("/qr", async (req, res) => {

  if (!ultimoQRCode) {
    return res.status(404).json({
      erro: "QR indisponível"
    });
  }

  const qrBase64 =
    await QRCode.toDataURL(ultimoQRCode);

  res.json({
    qr: qrBase64
  });
});

// ======================================
// 📩 AGENDAR
// ======================================
let loopEnvio = null;

app.post(
  "/agendar",
  upload.single("imagem"),
  async (req, res) => {

    try {

      const grupos =
        JSON.parse(req.body.grupos || "[]");

      const mensagem =
        req.body.mensagem || "";

      const tempo =
        req.body.tempo || "30";

      const imagem =
        req.file?.path || null;

      envioAtivo = true;

      // 🔥 DEFINE O TEMPO DO CICLO (AQUI É O MAIS IMPORTANTE)
      const intervaloLoop =
        tempo === "60"
          ? 60 * 60 * 1000   // 1 hora
          : 30 * 60 * 1000;  // 30 minutos

      console.log(`⏱️ Loop configurado para ${tempo} minutos`);

      async function iniciarLoop() {

        if (!envioAtivo) return;

        console.log("🔁 Iniciando novo ciclo de envio...");

        await escalonarEnvio(
          grupos,
          mensagem,
          tempo,
          imagem
        );

        if (envioAtivo) {

          console.log(`⏳ Próximo ciclo em ${tempo} minutos`);

          loopEnvio = setTimeout(() => {
            iniciarLoop();
          }, intervaloLoop);
        }
      }

      // 🚀 inicia o loop
      iniciarLoop();

      res.json({
        sucesso: true,
        mensagem: `🚀 Envio iniciado a cada ${tempo} minutos`
      });

    } catch (err) {

      console.error("❌ /agendar:", err);

      res.status(500).json({
        erro: err.message
      });
    }
  }
);

// ======================================
// 🛑 PARAR
// ======================================
app.post("/parar", (req, res) => {

  envioAtivo = false;

  if (loopEnvio) {
    clearTimeout(loopEnvio);
    loopEnvio = null;
  }

  console.log("⛔ Loop de envio parado");

  res.json({
    sucesso: true,
    mensagem: "⛔ Envio parado"
  });
});

// ======================================
// ⚙️ CONFIG
// ======================================
app.get("/api/respostas", (req, res) => {

  const data =
    JSON.parse(fs.readFileSync(configPath, "utf8"));

  res.json(data);
});

app.post("/api/respostas", (req, res) => {

  fs.writeFileSync(
    configPath,
    JSON.stringify(req.body, null, 2)
  );

  res.json({
    ok: true
  });
});

// ======================================
// 🔌 ATIVAR / DESATIVAR BOT
// ======================================
app.post("/api/respostas/ativar", (req, res) => {

  const data =
    JSON.parse(fs.readFileSync(configPath, "utf8"));

  data.ativo = !!req.body.ativo;

  fs.writeFileSync(
    configPath,
    JSON.stringify(data, null, 2)
  );

  res.json({
    ativo: data.ativo
  });
});

// ======================================
// 🚀 START
// ======================================
app.listen(PORT, () => {
  console.log(`🚀 Rodando em http://localhost:${PORT}`);
});

startWhatsApp();