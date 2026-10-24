/* global document, window, navigator, localStorage, URLSearchParams, setTimeout, clearTimeout */
const translationsZh = {
    skip: "跳到正文",
    mainNav: "主导航",
    mobileNav: "移动导航",
    footerNav: "页脚导航",
    navProduct: "产品",
    navCapabilities: "功能",
    navDocs: "文档",
    menu: "菜单",
    release: "认识 MiniBox v__MINIBOX_VERSION__",
    heroLine1: "让 Agent 放手做",
    heroLine2: "让一切始终可控",
    heroDescription: "独立工作空间、实时终端与随时可恢复的成果\n都在你自己的机器上",
    getStarted: "开始使用",
    readDocs: "阅读文档",
    selfHosted: "自主部署",
    noAccount: "无需平台账号",
    screenshotsLabel: "控制台截图",
    tabOverview: "概览",
    tabBoxes: "Box 列表",
    tabTerminal: "终端",
    enlarge: "放大截图",
    agentsLabel: "兼容的 AI Agent",
    anyMcp: "任意 MCP 客户端",
    capabilitiesLine1: "从第一条命令",
    capabilitiesLine2: "到下一台机器",

    terminalTitle: "随时接手，无需从头开始",
    terminalDescription: "在持久终端里跟进 Agent 的工作。需要时接管，完成后交还，工作不中断。",
    terminalLink: "了解终端与会话",
    accessTitle: "放开能力，划好边界",
    accessDescription: "为每个令牌指定可访问的 Box、主机与操作。按需设置配额，随时撤销权限。",
    scopedToken: "受限令牌",
    runCommands: "运行命令",
    readWrite: "读写文件",
    otherBoxes: "其他 Box 与密钥",
    tokenTtl: "4 小时 TTL",
    checkpointTitle: "大胆尝试，也能回到从前",
    checkpointDescription: "用检查点保存工作，分叉出新 Box，或回滚到之前的状态。导出加密包，在别处留一份。",
    checkpointLink: "了解检查点",
    checkpointBase: "保存当前成果",
    checkpointIdea: "尝试新想法",
    checkpointBack: "回到好状态",
    workKept: "成果始终在",
    hostsTitle: "一个面板，管好你的机器",
    hostsDescription: "连接工作站、家用服务器与远程主机。按可用容量分配 Box，也能连同数据一起迁移。",
    hostsLink: "连接更多主机",
    workstation: "工作站",
    homeServer: "家用服务器",
    remoteHost: "远程主机",
    templatesTitle: "从熟悉的环境出发",
    templatesDescription: "模板、代码仓库与 devcontainer",
    filesTitle: "文件始终触手可及",
    filesDescription: "持久卷、NAS 与文件浏览器",
    notificationsTitle: "需要你时，及时知晓",
    notificationsDescription: "Webhook、ntfy 与 Telegram 通知",
    startLine1: "下一个工作空间",
    startLine2: "就从这里开始",
    startDescription: "一台 Linux 机器、Docker 和几条命令\n然后打开 MiniBox，创建你的第一个 Box",
    installationGuide: "查看快速开始",
    installHeading: "安装 MiniBox",
    copy: "复制",
    copied: "已复制安装命令",
    copyFailed: "浏览器未允许复制，请手动选中并复制命令。",
    installFooter: "打开 127.0.0.1:3920，使用访问密钥登录",
    faqTitle: "你可能想知道",
    faq1Question: "MiniBox 运行在哪里？",
    faq1Answer:
      "在你自己的 Linux 机器上，需要安装 Docker。需要更多容量时，可以接入远程主机。MiniBox 以 Apache-2.0 协议开源，无需平台账号，也没有平台订阅费。",
    faq2Question: "可以在 Box 里运行不可信代码吗？",
    faq2Answer:
      "Box 使用 Docker 容器隔离，与宿主机共享内核。MiniBox 面向可信的所有者及其 Agent，不可信的第三方工作负载需要更强的隔离方案。",
    faq3Question: "Box 变化后，我的工作还在吗？",
    faq3Answer:
      "工作区与 home 数据独立保存在持久卷中，重建后仍然保留。检查点可以用于分叉或回滚。请把导出的检查点与服务端备份保存在主机以外，以便恢复。",
    faq4Question: "我的 Agent 如何接入？",
    faq4Answer:
      "通过 MCP、CLI、SSH 或 REST API 接入。为每个 Agent 分配受限令牌，不要交出所有者主密钥。你也可以打开浏览器终端，与 Agent 协作。",
    closingTitle: "为下一个想法，留出空间",

    issues: "问题反馈",
    notices: "第三方声明",
    dialogTitle: "走进 MiniBox",
    closePreview: "关闭截图",
  },
  translationsEn = {
    copied: "Installation commands copied.",
    copyFailed: "Copy isn't available. Select and copy the commands manually.",
  };
for (const element of document.querySelectorAll("[data-i18n]"))
  translationsEn[element.dataset.i18n] ??= element.innerText || element.textContent;
for (const element of document.querySelectorAll("[data-i18n-aria]"))
  translationsEn[element.dataset.i18nAria] ??= element.getAttribute("aria-label");
const screenshots = {
  overview: {
    file: "overview-light.png",
    en: "MiniBox overview with CPU, memory and disk metrics, resource quotas, and running boxes",
    zh: "MiniBox 概览：CPU、内存、磁盘指标、资源配额与运行中的 Box",
  },
  boxes: {
    file: "boxes-light.png",
    en: "MiniBox box list with running status, resource limits, and box actions",
    zh: "MiniBox 的 Box 列表：运行状态、资源限制与管理操作",
  },
  terminal: {
    file: "box-terminal-light.png",
    en: "MiniBox box page with a terminal session that an agent is driving",
    zh: "MiniBox Box 页面，显示 Agent 正在操作的终端会话",
  },
};

let language = "en";
let selectedScreenshot = "overview";
let toastTimeout;

function updateScreenshot() {
  const screenshot = screenshots[selectedScreenshot];
  const folder = language === "zh" ? "zh-CN" : "en";
  for (const image of document.querySelectorAll("#product-screenshot, #dialog-screenshot")) {
    image.src = `./assets/screenshots/${folder}/${screenshot.file}`;
    image.alt = screenshot[language];
  }
}

function setLanguage(value) {
  language = value === "zh" ? "zh" : "en";
  const translations = language === "zh" ? translationsZh : translationsEn;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title =
    language === "zh"
      ? "MiniBox — 让 Agent 放手做，让一切始终可控"
      : "MiniBox — Let your agents work. Stay in control.";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = translations[element.dataset.i18n];
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    element.setAttribute("aria-label", translations[element.dataset.i18nAria]);
  }
  const folder = language === "zh" ? "zh-CN" : "en";
  for (const image of document.querySelectorAll("[data-terminal-image]")) {
    image.src = `./assets/screenshots/${folder}/box-terminal-light.png`;
    image.alt =
      language === "zh"
        ? "Agent 正在操作的共享终端，可通过接管控件继续工作"
        : "A shared terminal with the agent driving and a Take over control";
  }
  for (const link of document.querySelectorAll("[data-doc]")) {
    link.href = `https://github.com/ArnoChenFx/minibox/blob/main/docs/${language === "zh" ? "zh-CN/" : ""}${link.dataset.doc}`;
  }
  const button = document.querySelector("[data-language]");
  button.textContent = language === "zh" ? "EN" : "中文";
  button.setAttribute("aria-label", language === "zh" ? "Switch to English" : "切换为中文");
  button.lang = language === "zh" ? "en" : "zh-CN";
  const url = new URL(window.location.href);
  if (language === "zh") url.searchParams.set("lang", "zh");
  else url.searchParams.delete("lang");
  window.history.replaceState(null, "", url);
  try {
    localStorage.setItem("minibox-home-language", language);
  } catch {
    // The URL still supports language selection when storage is unavailable.
  }
  updateScreenshot();
}

function selectScreenshot(value, focus = false) {
  selectedScreenshot = value;
  for (const tab of document.querySelectorAll("[data-screenshot]")) {
    const selected = tab.dataset.screenshot === value;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  document.querySelector("#screenshot-panel").setAttribute("aria-labelledby", `tab-${value}`);
  updateScreenshot();
}

for (const tab of document.querySelectorAll("[data-screenshot]")) {
  tab.addEventListener("click", () => selectScreenshot(tab.dataset.screenshot));
  tab.addEventListener("keydown", (event) => {
    const names = Object.keys(screenshots);
    let index = names.indexOf(selectedScreenshot);
    if (event.key === "ArrowRight") index = (index + 1) % names.length;
    else if (event.key === "ArrowLeft") index = (index - 1 + names.length) % names.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = names.length - 1;
    else return;
    event.preventDefault();
    selectScreenshot(names[index], true);
  });
}
document.querySelector("[data-language]").addEventListener("click", () => setLanguage(language === "en" ? "zh" : "en"));

let initialLanguage = "en";
const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
if (requestedLanguage === "en" || requestedLanguage === "zh") initialLanguage = requestedLanguage;
else {
  try {
    initialLanguage = localStorage.getItem("minibox-home-language") === "zh" ? "zh" : "en";
  } catch {
    // English content is already present in the HTML.
  }
}
setLanguage(initialLanguage);

function showToast(message) {
  const toast = document.querySelector(".toast");
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add("visible");
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4500);
}
document.querySelector("[data-copy]").addEventListener("click", async () => {
  const translations = language === "zh" ? translationsZh : translationsEn;
  try {
    await navigator.clipboard.writeText(document.querySelector("#install-command").textContent);
    showToast(translations.copied);
  } catch {
    showToast(translations.copyFailed);
  }
});

const dialog = document.querySelector(".screenshot-dialog");
document.querySelector("[data-preview-open]").addEventListener("click", () => dialog.showModal());
document.querySelector("[data-preview-close]").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  ) {
    dialog.close();
  }
});
for (const link of document.querySelectorAll(".mobile-menu a")) {
  link.addEventListener("click", () => {
    document.querySelector(".mobile-menu").open = false;
  });
}
