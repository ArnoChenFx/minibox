/* global document, window, navigator, localStorage, URLSearchParams, setTimeout, clearTimeout */
const translationsZh = {
    skip: "跳到正文",
    mainNav: "主导航",
    mobileNav: "移动导航",
    footerNav: "页脚导航",
    navProduct: "产品",
    navWorkflow: "使用流程",
    navDocs: "文档",
    menu: "菜单",
    heroEyebrow: "小小的 Box，装得下大大的想法",
    heroLine1: "你的 Agent。",
    heroLine2: "你的机器。",
    heroLine3: "你说了算。",
    heroDescription:
      "为 AI 编程 Agent 准备的个人工作空间。创建 Docker Box，让它们放手构建，自己随时观察与接管。一切都运行在你自己的机器上。",
    getStarted: "开始使用",
    exploreProject: "了解开源项目",
    heroNote: "开源 · 自托管 · 无平台订阅费",
    illustrationLabel: "个人 Docker 工作空间与终端的示意图",
    running: "运行中",
    compute: "计算资源",
    memory: "内存",
    persistent: "持久保存",
    workspace: "工作空间",
    yourFiles: "给文件一个家",
    terminalComment: "# 给下一个想法，一个干净的开始。",
    stickerTitle: "放心尝试。",
    stickerDescription: "给 Agent 独立的工作空间。",
    illustrationCaption: "工作空间示意图。一切由你掌握。",
    agentsEyebrow: "带上你喜欢的 Agent",
    anyMcp: "任意 MCP 客户端",
    productEyebrow: "一扇窗口，掌握全局",
    productTitle: "让 Agent 忙碌，让自己心里有数。",
    productDescription: "Box、资源用量、终端会话。在一个清爽的控制台里，看看一切进展如何。",
    screenshotsLabel: "控制台截图",
    tabOverview: "概览",
    tabBoxes: "Box 列表",
    tabTerminal: "终端",
    browserAddress: "你的机器 / minibox",
    enlarge: "放大截图",
    screenshotCaption: "真实的 MiniBox 控制台，无需注册云平台账号。",
    featuresEyebrow: "轻量运行，用心打磨",
    featuresTitle: "给 Agent 一个能安心干活的家。",
    featuresAside: `一个 Bun 进程，一个 Docker Engine。
装得下许多可能。`,
    storageTitle: "留下成果，告别杂乱。",
    storageDescription:
      "工作区与 home 独立保存在持久卷里，重建后代码和配置依然在。多个 Box 可以共享存储，也可以接入你的 NAS。",
    storageLink: "了解存储方式",
    controlTitle: "让 Agent 开车，随时接过方向盘。",
    controlDescription: "观察持久化的 tmux 会话，需要时接管，完成后交还。刷新页面，也不会打断正在进行的工作。",
    controlLink: "了解会话与接管",
    you: "你",
    interfacesTitle: "说 Agent 听得懂的语言。",
    interfacesDescription: "MCP、CLI 与 REST API 共用同一组操作。运行命令、管理文件，接入你已经在用的客户端。",
    tokensTitle: "主密钥归你，权限按需分配。",
    tokensDescription: "给每个 Agent 独立的令牌，只开放需要的 Box 和操作。设置配额，在任务完成后撤销权限。",
    tokensLink: "连接你的 Agent",
    lifecycleTitle: "少一些日常打理。",
    lifecycleDescription:
      "空闲 Box 自动休眠、按需唤醒。配合 CPU 与内存配额、TTL、系统快照和检查点，让工作空间井井有条。",
    lifecycleLink: "了解生命周期",
    workflowEyebrow: "从想法，到工作空间",
    workflowTitle: "一个 Box，一个 Agent，开工。",
    workflowLink: "阅读 Agent 接入指南",
    step1Title: "先腾出一点空间。",
    step1Description: "选择模板、给 Box 起个名字、选好工具。一个全新的工作空间，不用再多维护一台虚拟机。",
    ready: "已就绪",
    step2Title: "带上你的 Agent。",
    step2Description: "创建受限令牌，连接 MCP 客户端，或者使用 CLI 和 API。让 Agent 有自己的地方来构建。",
    step3Title: "随时看看进展。",
    step3Description: "跟进终端、预览应用，需要时接管。在尝试新想法之前，用检查点保存当前成果。",
    step3Code: "观察 · 接管 · 交还",
    startEyebrow: "下一个想法，从这里开始",
    startTitle: `简单的开始。
自己的空间。`,
    startDescription:
      "在安装了 Docker Engine 和 Bun 1.4.3 或更高版本的 Linux 机器上启动 MiniBox。前端已经包含在内，无需额外的数据库服务。",
    installationGuide: "完整安装指南",
    noDatabase: "无需数据库服务",
    installHeading: "从源码启动",
    copy: "复制",
    copied: "已复制安装命令",
    copyFailed: "浏览器未允许复制，请手动选中并复制命令。",
    installFooter: "然后在自己的机器上打开 127.0.0.1:3920。",
    setupNote:
      "首次启动时，MiniBox 会在 data/access_key 中保存自动生成的访问密钥。用它登录控制台，给 Agent 使用受限令牌。远程访问请通过 HTTPS 或私有网络。",
    faqEyebrow: "你可能还想知道",
    faqTitle: "开始之前，聊几句。",
    faq1Question: "MiniBox 是托管云服务吗？",
    faq1Answer:
      "MiniBox 运行在你自己的机器上，以 MIT 协议开源。无需 MiniBox 账号，也没有平台订阅费。你需要提供自己的硬件，以及 Agent 使用付费 AI 服务时所需的凭据。",
    faq2Question: "可以在 Box 里运行不可信代码吗？",
    faq2Answer:
      "Box 使用 Docker 容器隔离，与宿主机共享内核。它适合运行你自己的 Agent，不能当作不可信第三方代码的安全边界。如果工作负载需要，请使用更强的隔离方案。",
    faq3Question: "删除 Box 后，文件会怎样？",
    faq3Answer:
      "工作区与 home 的数据保存在独立于容器可写层的卷里。删除 Box 时，可以选择保留哪些归属卷。系统快照不包含挂载卷；检查点可以保存工作区和 home 的数据。",
    faq4Question: "能连接我正在使用的编程 Agent 吗？",
    faq4Answer:
      "支持 Streamable HTTP MCP 的客户端都可以连接 MiniBox，也可以通过 CLI 和 REST API 接入。工具目录支持在 Box 里安装已适配的 Agent CLI。请给 Agent 分配受限令牌，而不是所有者主密钥。",
    closingEyebrow: "小小的 Box，大大的可能",
    closingTitle: "给下一个大想法，腾一点空间。",
    closingDescription: "你的机器，你喜欢的 Agent，一个可以放手构建的地方。",
    footerNote: "为个人机器与好奇心而造。",
    issues: "问题与想法",
    dialogTitle: "走进 MiniBox",
    closePreview: "关闭截图",
  },
  translationsEn = {
    copied: "Installation commands copied.",
    copyFailed: "Copy isn't available. Select and copy the commands manually.",
  };
for (const element of document.querySelectorAll("[data-i18n]"))
  translationsEn[element.dataset.i18n] ??= element.innerText;
for (const element of document.querySelectorAll("[data-i18n-aria]"))
  translationsEn[element.dataset.i18nAria] ??= element.getAttribute("aria-label");
const screenshots = {
  overview: {
    src: "./assets/screenshots/overview-light.png",
    en: "MiniBox overview with CPU, memory and disk metrics, resource quotas, and running boxes",
    zh: "MiniBox 概览：CPU、内存、磁盘指标、资源配额与运行中的 Box",
  },
  boxes: {
    src: "./assets/screenshots/boxes-light.png",
    en: "MiniBox box list with running status, resource limits, and box actions",
    zh: "MiniBox 的 Box 列表：运行状态、资源限制与管理操作",
  },
  terminal: {
    src: "./assets/screenshots/terminal-light.png",
    en: "MiniBox web terminal inside a Docker box",
    zh: "MiniBox 中连接到 Docker Box 的网页终端",
  },
};

let language = "en";
let selectedScreenshot = "overview";
let toastTimeout;

function updateScreenshot() {
  const screenshot = screenshots[selectedScreenshot];
  for (const image of document.querySelectorAll("#product-screenshot, #dialog-screenshot")) {
    image.src = screenshot.src;
    image.alt = screenshot[language];
  }
}

function setLanguage(value) {
  language = value === "zh" ? "zh" : "en";
  const translations = language === "zh" ? translationsZh : translationsEn;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title =
    language === "zh"
      ? "MiniBox — 你的 Agent。你的机器。你说了算。"
      : "MiniBox — Your agents. Your machine. Your rules.";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = translations[element.dataset.i18n];
  }
  for (const element of document.querySelectorAll("[data-i18n-aria]")) {
    element.setAttribute("aria-label", translations[element.dataset.i18nAria]);
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
