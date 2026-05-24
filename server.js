import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import QRCode from "qrcode";

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
let envioAtivo = false;
let primeiroCiclo = true; // 🔥 ESSENCIAL
// ======================================
// 🔧  PATHS
// ======================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======================================
// 📁 ESTRUTURA /data
// ======================================
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const configPath = path.join(dataDir, "respostas.json");
const leadsPath = path.join(dataDir, "leads.json");
const funilStatePath = path.join(dataDir, "funil_state.json");
const grupoStatsPath = path.join(dataDir, "grupo_stats.json");

// ======================================
// 📁 DEFAULT FILES
// ======================================
function initFile(file, defaultData) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
  }
}

initFile(configPath, {
  ativo: true,
  privado: { gatilhos: ["oi"], resposta: "Olá!" },
  grupo: { gatilhos: ["menu"], resposta: "Nosso menu..." },
  funil: {
    ativo: true,
    gatilhos: ["tenho interesse", "quero"],
    respostas_positivas: ["sim", "ok"],
    etapas: [
      { mensagem: "Olá {{nome}} 👀", delay: 2, esperarResposta: true },
      { mensagem: "Posso te explicar como funciona", delay: 3, esperarResposta: true },
      { mensagem: "Aqui está a oferta 🔥", delay: 3, esperarResposta: false }
    ]
  }
});

initFile(leadsPath, []);
initFile(funilStatePath, {});
initFile(grupoStatsPath, {});

// ======================================
// 🔧 HELPERS
// ======================================
const delay = ms => new Promise(res => setTimeout(res, ms));

function delayHumano() {
  return 2000 + Math.floor(Math.random() * 4000);
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

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function contemGatilho(texto, gatilhos = []) {
  texto = texto.toLowerCase();
  return gatilhos.some(g => texto.includes(g.toLowerCase()));
}

// ======================================
// 🌐 EXPRESS
// ======================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage()
});

// ======================================
// 📲 WHATSAPP
// ======================================
let sock;
let ultimoQRCode = null;
let whatsappStatus = "desconectado";
let gruposDisponiveis = [];
let envioAtivo = false;

async function startWhatsApp() {

  const authPath = path.join(__dirname, "data", "auth");

  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr }) => {

    if (qr) {
      ultimoQRCode = qr;
      console.log("📲 QR gerado");
    }

    if (connection === "open") {
      whatsappStatus = "conectado";
      console.log("✅ Conectado");

      const grupos = await sock.groupFetchAllParticipating();
      gruposDisponiveis = Object.values(grupos).map(g => ({
        id: g.id,
        nome: g.subject
      }));
    }

    if (connection === "close") {
      whatsappStatus = "desconectado";
      console.log("🔄 Reconectando...");
      setTimeout(startWhatsApp, 5000);
    }
  });

  // ======================================
  // 📩 MENSAGENS
  // ======================================
  sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const numero = msg.key.remoteJid;
    const texto = getTextMessage(msg.message).toLowerCase().trim();
    if (!texto) return;

    const isGrupo = numero.endsWith("@g.us");

    // ======================================
    // 🔥 CONTADOR DE GRUPO (ANTI-SPAM)
    // ======================================
if (isGrupo) {

  const stats = readJSON(grupoStatsPath);

  if (!stats[numero]) {
    stats[numero] = {
      mensagens: 0,
      ultimaMensagemBot: 0,
      ultimaAtividade: 0
    };
  }

  stats[numero].mensagens++;
  stats[numero].ultimaAtividade = Date.now(); // 🔥 ESSENCIAL

  writeJSON(grupoStatsPath, stats);
}

    // ======================================
    // 🤖 RESPOSTAS SIMPLES
    // ======================================
    const config = readJSON(configPath);
// ======================================
// 🧠 FUNIL
// ======================================
const funil = config.funil;
let funilState = readJSON(funilStatePath);
let leads = readJSON(leadsPath);

// 🔥 Só funciona no PRIVADO
if (!isGrupo && funil?.ativo) {

  // ================================
  // 🚀 INICIAR FUNIL
  // ================================
  if (!funilState[numero] && contemGatilho(texto, funil.gatilhos)) {

    console.log("🚀 Iniciando funil:", numero);

    // salvar lead
    leads.push({
      numero,
      nome: msg.pushName || "Sem nome",
      inicio: Date.now()
    });
    writeJSON(leadsPath, leads);

    // iniciar etapa 0
    funilState[numero] = {
      etapa: 0,
      aguardando: funil.etapas[0].esperarResposta
    };
    writeJSON(funilStatePath, funilState);

    // enviar primeira mensagem
    const etapa = funil.etapas[0];
    const mensagem = etapa.mensagem.replace("{{nome}}", msg.pushName || "");

    await delay(etapa.delay * 1000);
    await sock.sendMessage(numero, { text: mensagem });

    return;
  }

  // ================================
  // 🔁 CONTINUAR FUNIL
  // ================================
  if (funilState[numero]) {

    let estado = funilState[numero];
    let etapaAtual = estado.etapa;

    // se precisa resposta
    if (estado.aguardando) {

      if (!contemGatilho(texto, funil.respostas_positivas)) {
        return;
      }
    }

    // próxima etapa
    etapaAtual++;

    if (!funil.etapas[etapaAtual]) {
      console.log("🏁 Funil finalizado:", numero);
      delete funilState[numero];
      writeJSON(funilStatePath, funilState);
      return;
    }

    const etapa = funil.etapas[etapaAtual];

    estado.etapa = etapaAtual;
    estado.aguardando = etapa.esperarResposta;

    funilState[numero] = estado;
    writeJSON(funilStatePath, funilState);

    const mensagem = etapa.mensagem.replace("{{nome}}", msg.pushName || "");

    await delay(etapa.delay * 1000);
    await sock.sendMessage(numero, { text: mensagem });

    return;
  }
}
// 🔥 só responde simples se NÃO estiver no funil
if (!funilState[numero]) {
  const regra = isGrupo ? config.grupo : config.privado;

  if (contemGatilho(texto, regra.gatilhos)) {
    await sock.sendMessage(numero, { text: regra.resposta });
  }
}
  });
}

// ======================================
// 📩 ENVIO EM MASSA COM FILTRO (CORRIGIDO)
// ======================================

async function escalonarEnvio(grupos, mensagem, imagem) {

  if (!Array.isArray(grupos) || grupos.length === 0) {
    console.log("⚠️ Nenhum grupo válido");
    return;
  }

  const stats = readJSON(grupoStatsPath) || {};
  const agora = Date.now();

  // 🔧 CONFIGURAÇÕES
  const MIN_MENSAGENS = 10;
  const MAX_TEMPO_INATIVO = 30 * 60 * 1000; // 30 min
  const COOLDOWN_ENVIO = 60 * 60 * 1000; // 1 hora
  const RESET_GRUPO_MORTO = 2 * 60 * 60 * 1000; // 2 horas

  console.log("📢 Iniciando ciclo | Primeiro ciclo:", primeiroCiclo);

  for (let grupo of grupos) {

    if (!envioAtivo) break;

    // 🔥 garantir estrutura
    if (!stats[grupo]) {
      stats[grupo] = {
        mensagens: 0,
        ultimaMensagemBot: 0,
        ultimaAtividade: 0
      };
    }

    let data = stats[grupo];

    const tempoDesdeUltimaAtividade = agora - (data.ultimaAtividade || 0);
    const tempoDesdeUltimoEnvio = agora - (data.ultimaMensagemBot || 0);

    const ativoRecente = tempoDesdeUltimaAtividade < MAX_TEMPO_INATIVO;
    const podeEnviar = tempoDesdeUltimoEnvio > COOLDOWN_ENVIO;

    // 🔥 limpar grupo morto
    if (tempoDesdeUltimaAtividade > RESET_GRUPO_MORTO) {
      console.log("🧹 Reset grupo inativo:", grupo);
      data.mensagens = 0;
      stats[grupo] = data;
      writeJSON(grupoStatsPath, stats);
      continue;
    }

    // ======================================
    // 🔥 FILTRO ANTI-SPAM (APÓS PRIMEIRO CICLO)
    // ======================================
    if (!primeiroCiclo) {

      if (data.mensagens < MIN_MENSAGENS) {
        console.log("⛔ Ignorado (pouca atividade):", grupo);
        continue;
      }

      if (!ativoRecente) {
        console.log("⛔ Ignorado (grupo parado):", grupo);
        continue;
      }

      if (!podeEnviar) {
        console.log("⛔ Ignorado (cooldown ativo):", grupo);
        continue;
      }
    }

    try {

      if (imagem) {
        await sock.sendMessage(grupo, {
          image: imagem.buffer,
          caption: mensagem || ""
        });
      } else {
        await sock.sendMessage(grupo, {
          text: mensagem
        });
      }

      console.log("✅ Enviado:", grupo);

      // 🔥 reset após envio
      data.mensagens = 0;
      data.ultimaMensagemBot = Date.now();

      stats[grupo] = data;
      writeJSON(grupoStatsPath, stats);

    } catch (err) {
      console.log("❌ Erro ao enviar:", grupo, err?.message);
    }

    // 🔥 delay humano
    const tempoDelay = 15000 + Math.random() * 10000;
    await delay(tempoDelay);
  }

  // 🔥 ativar filtro após primeiro ciclo
  if (primeiroCiclo) {
    console.log("✅ Primeiro ciclo concluído - ativando filtro anti-spam");
    primeiroCiclo = false;
  }
}

// ======================================
// 🌐 ROTAS
// ======================================
app.get("/verificar", (req, res) => {
  res.json({ status: whatsappStatus });
});

app.get("/qr", async (req, res) => {
  if (!ultimoQRCode) return res.status(404).json({ erro: "Sem QR" });

  const qr = await QRCode.toDataURL(ultimoQRCode);
  res.json({ qr });
});

app.get("/grupos", (req, res) => {
  res.json(gruposDisponiveis);
});

let loopEnvio;


app.post("/agendar", upload.single("imagem"), async (req, res) => {
  try {
    let { grupos, mensagem, tempo } = req.body;

    // 🔥 Corrigir grupos vindo como string
    if (typeof grupos === "string") {
      try {
        grupos = JSON.parse(grupos);
      } catch {
        grupos = [];
      }
    }

    // 🔥 Validação
    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ erro: "Nenhum grupo selecionado" });
    }

    if (!mensagem && !req.file) {
      return res.status(400).json({ erro: "Envie mensagem ou imagem" });
    }

    envioAtivo = true;

    const intervalo = tempo === "60"
      ? 60 * 60 * 1000
      : 30 * 60 * 1000;

    // 🔥 IMPORTANTE: salvar imagem fora do req (senão perde no loop)
    const imagem = req.file
      ? { buffer: req.file.buffer, mimetype: req.file.mimetype }
      : null;

    async function loop() {
      if (!envioAtivo) return;

      await escalonarEnvio(grupos, mensagem, imagem);

      loopEnvio = setTimeout(loop, intervalo);
    }

    loop();

    res.json({
      ok: true,
      mensagem: "Envio iniciado com sucesso 🚀"
    });

  } catch (err) {
    console.error("Erro no agendar:", err);
    res.status(500).json({ erro: "Erro interno no servidor" });
  }
});

app.post("/parar", (req, res) => {

  envioAtivo = false; // 🔥 ESSENCIAL

  if (loopEnvio) {
    clearTimeout(loopEnvio);
  }

  res.json({
    ok: true,
    mensagem: "Envio pausado com sucesso 🛑"
  });
});

// ======================================
// 📋 EXTRAIR CONTATOS
// ======================================
app.get("/api/extrair/:grupoId", async (req, res) => {
  try {

    if (whatsappStatus !== "conectado") {
      return res.status(400).json({ erro: "WhatsApp desconectado" });
    }

    const grupoId = req.params.grupoId;

    const metadata = await sock.groupMetadata(grupoId);

    if (!metadata?.participants) {
      return res.status(400).json({
        erro: "Grupo sem participantes"
      });
    }

    const contatos = metadata.participants.map(p => ({
      nome:
        p.notify ||
        p.verifiedName ||
        p.id.split("@")[0],

      numero: p.id.replace("@s.whatsapp.net", "")
    }));

    res.json({
      sucesso: true,
      contatos
    });

  } catch (err) {
    console.error("❌ Erro extrair:", err);
    res.status(500).json({ erro: err.message });
  }
});

// ======================================
// 📨 ENVIAR PRIVADO
// ======================================
app.post("/api/enviar", async (req, res) => {
  try {

    if (whatsappStatus !== "conectado") {
      return res.status(400).json({ erro: "WhatsApp desconectado" });
    }

    const contatos = req.body.contatos || [];
    const mensagem = req.body.mensagem || "";

    if (!contatos.length) {
      return res.status(400).json({
        erro: "Nenhum contato enviado"
      });
    }

    let enviados = 0;
    let erros = 0;
    let ignorados = 0;

    let enviadosNoCiclo = 0;

    console.log(`🚀 Envio para ${contatos.length} contatos`);

    function delayHumano() {
      return 8000 + Math.floor(Math.random() * 15000);
    }

    for (const contato of contatos) {

      if (whatsappStatus !== "conectado") {
        await delay(15000);
        continue;
      }

      if (
        !contato.numero ||
        contato.numero.includes("@lid") ||
        contato.numero.length < 10
      ) {
        ignorados++;
        continue;
      }

      const jid = contato.numero + "@s.whatsapp.net";

      if (enviadosNoCiclo >= 10) {
        console.log("⏳ Pausa de 1 hora...");
        await delay(60 * 60 * 1000);
        enviadosNoCiclo = 0;
      }

      try {

        await sock.sendPresenceUpdate("composing", jid);
        await delay(2000 + Math.random() * 3000);

        await sock.sendMessage(jid, { text: mensagem });

        enviados++;
        enviadosNoCiclo++;

        console.log("✅", contato.numero);

      } catch (err) {

        erros++;
        console.log("❌ erro", contato.numero);

        // retry
        try {
          await delay(5000);
          await sock.sendMessage(jid, { text: mensagem });
          enviados++;
          enviadosNoCiclo++;
        } catch {}
      }

      await delay(delayHumano());
    }

    res.json({
      sucesso: true,
      enviados,
      erros,
      ignorados
    });

  } catch (err) {
    console.error("❌ erro geral:", err);
    res.status(500).json({ erro: err.message });
  }
});

// ======================================
// ⚙️ CONFIG RESPOSTAS
// ======================================
app.get("/api/respostas", (req, res) => {
  try {
    const data = readJSON(configPath);
    res.json(data);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post("/api/respostas", (req, res) => {
  try {
    writeJSON(configPath, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ======================================
// 🔌 ATIVAR / DESATIVAR BOT
// ======================================
app.post("/api/respostas/ativar", (req, res) => {
  try {

    const data = readJSON(configPath);

    data.ativo = !!req.body.ativo;

    writeJSON(configPath, data);

    res.json({
      ativo: data.ativo
    });

  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});
















// ======================================
// 🚀 START
// ======================================
app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});

startWhatsApp();
