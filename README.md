# PCB 工作台 · 基础版

本地 H5 工作台，界面左侧讨论需求，右侧切换真实原理图和 PCB。首版实做 5 V 红色 LED 指示板（J1、R1、D1），限流电阻 220–1000 Ω。

这是可运行的源码基础版，目前以 Windows 本地运行验证为主。需要 Node.js 22+ 和 KiCad 9+。模型可选自己的兼容 API；如果使用本机 Codex，则需要安装并登录 Codex CLI。

## 下载与启动

在 GitHub 页面点击 **Code → Download ZIP**，解压后进入包含 `package.json` 的目录，打开终端运行：

```powershell
npm ci
npm start
```

打开 <http://127.0.0.1:3210>。设置 `PCB_PORT` 可以更换端口；找不到 KiCad 时，用 `PCB_KICAD_CLI` 指定 `kicad-cli.exe`。工程默认保存在本目录的 `data/`，可通过 `PCB_WORKBENCH_DATA` 更换位置。运行中不要直接修改此目录内的工程快照，应导出后在 EDA 中编辑，再导回。

Windows PowerShell 也可使用 `npm.cmd ci`、`npm.cmd start`。如果 KiCad 没有被自动找到，可先指定路径，再启动：

```powershell
$env:PCB_KICAD_CLI = 'C:\Program Files\KiCad\9.0\bin\kicad-cli.exe'
npm.cmd start
```

路径按自己安装的位置填写。程序不是直接双击 HTML 运行，使用期间请保持本机服务运行。

## 第一次使用

聊天区模型菜单选择「连接 / 手动配置模型」，填入自己的 API 基础地址和 Key，应用后点「获取列表」再选模型。如果接口不提供列表，就在设置中填写模型名称。API 地址类似 `https://example.com/v1`，不要填写 `/chat/completions`。不需要把 Key 写进源码。

首次试用：点击示例需求、发送，核对模型提案后确认生成原理图；可以先修改 R1 再确认继续布局布线，检查通过后下载完整工程 ZIP。画布由本机 KiCad 从当前工程输出，可以缩放、平移、选择元件、切换铜层和丝印。属性区直接填写 R1 值不调用模型，自然语言修改由模型提出提案，两者都经确认后在工程副本上写入并复检。程序保留旧版本，每次启动可以重新打开工程。

只想先查看工程，可以把 [470 Ω 示例](examples/led-indicator-470.zip) 或 [导回续改后的 680 Ω 示例](examples/led-roundtrip-680.zip) 解压，用 KiCad 打开其中的 `.kicad_pro`。应用的导回功能接收完整工程 ZIP。

## 模型与工程能力

聊天区顶部有「模型」下拉框，可以选择本机 Codex 或已配置 API 的模型。连接时可以只填写基础地址和 Key，默认模型名称选填。「获取列表」会向当前 API 发起一次 `GET /models`，列表来源采用 [Models API 的 data / id 格式](https://developers.openai.com/api/reference/resources/models/methods/list)。不支持模型列表的服务，可用菜单里的「连接 / 手动配置模型」直接填写模型名称。选择模型在本页完成，不发送模型请求；后续聊天和报告解读使用所选模型，回复旁标出本轮选择的模型。CLI 未指定模型时仍使用连接设置中的默认值。

模型设置支持本机 Codex 和自定义兼容 `/chat/completions` 的 API。填写的基础地址应类似 `https://example.com/v1`，不包含 `/chat/completions`。API Key 只保存在服务内存中，不写入工程、浏览器存储或配置文件；切回 Codex 会保留 API 连接，换 API 地址时不会继承旧地址的密钥。清空密钥请勾选对应选项。聊天模型偏好只保存模型名称和基础地址，服务重启后仍需重新配置未由环境变量提供的 API 连接。也可通过 `PCB_MODEL_BASE_URL`、`PCB_MODEL_NAME`、`PCB_MODEL_API_KEY` 配置启动默认值。模型接口调用不自动重试。

工程 ZIP 包含 `.kicad_pro`、`.kicad_sch`、`.kicad_pcb`、配套符号库和封装库。KiCad 可以直接编辑；嘉立创 EDA 专业版使用「导入 KiCad」打开 ZIP。KiCad 改过的整套工程可以 ZIP 导回，R1 值在原理图和 PCB 中需一致，导回时会重新检查。不会根据原模板覆盖导入文件中的走线、文字、开孔和用户附加文件。首版主文件名保持 `led-indicator`，只支持一张原理图和一块 PCB。

嘉立创保存的原生 `.epro` / `.eprj` 续改、跨软件反向转换、任意电路生成和真实商城选料尚未接入。当前布线使用指示板的固定拓扑，不是通用自动布线器。ERC/DRC 检查通过不代替实物打样和电气测试。

其他 Agent 可以用以下 CLI 调用同一工作台服务，复用界面使用的模型配置、工程版本和操作入口。

```powershell
node cli.mjs app projects
node cli.mjs app new
node cli.mjs app chat <工程ID> '做一块5V红色LED指示板，电阻请推荐'
node cli.mjs app open <工程ID>
node cli.mjs app set-r1 <工程ID> 470
node cli.mjs app confirm <工程ID> 0 <提案ID> --confirm
node cli.mjs app confirm <工程ID> 1 schematic --confirm
node cli.mjs app export <工程ID> board.zip
node cli.mjs app import board.zip
```

`PCB_WORKBENCH_URL` 可以指定其他本机端口。旧版独立 CLI 命令仍可使用，见 [WORKFLOW.md](WORKFLOW.md)。

`npm test` 专项验证指定模型请求、模型列表和手动填写、连接切换、失效确认拒绝、真实 KiCad 检查、导入续改只更新目标值及旧版本保留。模型端点在该测试中使用本机 HTTP 夹具，不把它当作外部服务或模型能力验证。独立审核结果及尚未实现的功能见 [AUDIT.md](AUDIT.md)。
