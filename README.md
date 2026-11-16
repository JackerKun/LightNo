# LIGHTNO · 移动测光表

> 一个为摄影现场准备的网页测光表：实时图像测光、拍照 EXIF 测光、点测光、区域框选、平均 / 高光 / 暗部测光，ND 补偿，带参数照片的测光日志。纯静态、零依赖、可离线安装，也能直接内嵌进 App。

<p align="center">
  <img src="./docs/meter.jpg" width="240" alt="测光界面" />
  <img src="./docs/log.jpg" width="240" alt="测光记录" />
  <img src="./docs/settings.jpg" width="240" alt="设置" />
</p>

LIGHTNO 在取景时为胶片机估算曝光。iPhone Safari 18.4 及以上会尝试从同一相机流间隔取样并读取 EXIF。安卓会优先尝试硬件曝光。需要手动测量时也可拍摄或导入 JPEG 原片。

**iPhone 原生版**使用 AVFoundation 连续测光并复用同一界面。参见 [Xcode 真机安装与安卓接入约定](ios/README.md)。

---

## 功能

### 六种测光模式

| 模式 | 行为 |
| --- | --- |
| **点测光** | 圆形测光区，可拖动、可缩放；默认把被测亮度放在 ZONE V（中灰），可改为 ZONE III–VIII |
| **区域框选** | 方形区域平均，适合大面积中间调 / 灰卡 |
| **中央重点** | 高斯加权，越靠画面中心权重越高 |
| **平均测光** | 整幅画面等权平均 |
| **高光优先** | 取画面 98 百分位亮度放到 ZONE VIII，保护高光 |
| **暗部优先** | 取画面 2 百分位亮度放到 ZONE III，保留暗部 |

### 取景与取景框

- 空白处点按：测光框立即移到该点；拖动：移动测光框；右下角手柄：调整大小
- 双指捏合 / 右侧滑杆：变焦（优先硬件变焦，不支持时自动数码变焦，测光采样同步裁切）
- 左下角相机按钮：**拍照测光**（读取系统相机照片 EXIF，估算胶片曝光；照片上可拖动测光区）
- 顶部 HUD：模式、变焦、锁定、演示标记 + 实时直方图（log2 亮度 + 中灰刻度 + 溢出提示）
- 高光溢出斑马纹、三分构图网格、屏幕常亮
- 双击画面 / 右上角锁按钮：锁定测光，方便锁定后重新构图

### 读数与曝光

- 画面亮度差、反差和色温估算；硬件曝光读数有效时显示 EV100 估算
- ISO / 光圈 / 快门 / ND 四个曝光单元：**上下滑动 / 鼠标滚轮 / 键盘 ↑↓** 切换，滑动时浮层显示**相邻档位**，点按打开选择器
- **曝光优先**：调光圈 → 测光决定快门（光圈优先）；调快门 → 测光决定光圈（快门优先），自动值带 `AUTO` 标记
- **等效曝光阶梯**：同一 EV 下相邻光圈的快门组合，点一下即切换
- 推荐快门按 1/3 档取整，同时给出精确值；超出范围会以琥珀色提示

### ND 减光镜

选择 ND2 / ND4 / ND8 / ND16 / ND32 / ND64 / ND128 / ND256 / ND512 / ND1000，或自定义 0–15 档（1/3 档步进）。

ND 只改变推荐曝光，不改变场景 EV：

```
t' = t × 2^ND档数        // 光圈优先：延长快门
```

例：EV 12、f/8、ISO 100 → 基准快门 1/64s；装 **ND16（4 档）** 后直接使用 **1/4s**。界面会同时显示基准快门与最终快门。

**快门优先**时快门由你固定，ND 由光圈补偿（例如 1/4s + ND16 会得到 f/8 的光圈解）。

### 曝光优先与拨盘

四个曝光单元都是「拨盘」：

- 手机：在单元上**上下滑动**
- 桌面：鼠标滚轮，或聚焦后按 **↑ / ↓**
- 点按单元：打开大号选择器（ISO / 光圈 / 快门 / ND）
- 滑动时会浮出**档位拨盘**：中间是当前值，上下显示相邻档位（类似相机拨轮 / iOS 滚轮）
- 测完光点 EV 数字可 **HOLD** 锁定读数，详见下文

规则：

| 操作 | 结果 |
| --- | --- |
| 调**光圈** | 进入**光圈优先**，测光自动计算快门 |
| 调**快门** | 进入**快门优先**，测光自动计算光圈 |
| 调 ISO / ND | 保持当前优先模式，曝光随之更新 |

自动值会显示 `AUTO` 标记；手动值显示「手动设定」。也可以在「测光选项 → 曝光优先」里显式切换，切换时会用当前读数保持曝光不变。光圈优先时 ND 延长快门；快门优先时 ND 由光圈补偿。

### HOLD 锁定读数

测完光后**点一下 EV 数字**即可锁定（也可以点右上角锁，或双击取景画面）：

- EV、亮度 / 反差 / 色温、直方图与斑马纹全部**冻结**，移动手机、重新取景都不会改变读数
- 支持手动曝光的设备上，选择「硬件曝光」引擎后手机相机曝光也会停在锁定时的设置，预览保持稳定；画面分析只冻结读数，预览仍会自动曝光
- 按钮变成琥珀色「解除」，画面角标显示 `HOLD`
- 再次点击 EV 数字（或锁按钮 / 双击画面）→ 解除，继续实时测光
- 锁定状态下仍可调整 ISO / 光圈 / 快门 / ND，推荐曝光会基于锁定的 EV 重新计算
- 切换到「记录 / 设置」再回到测光页，锁定仍然保留；刷新页面会解除
- 锁定后直接按保存，会用锁定的读数与当前曝光参数生成测光记录

### 测光日志

- 点取景框下方的保存键：拍下当前画面，并烧录 EV、模式、ISO、光圈、快门、ND、亮度、反差、色温、测光框位置、时间、坐标（可选）
- 记录以 **Blob + IndexedDB** 存在本机，缩略图列表、详情、备注、收藏、单张下载
- 支持 **JSON 备份导出 / 导入**（含照片的 base64），换机或清缓存前请先导出
- 记录页支持全部 / 今天 / 本周 / 收藏筛选

### 校准、拍照测光与引擎自检

- **自动（默认）**：iPhone 取景时每隔约两秒尝试取样，在内存中读取 EXIF 并分析选区。样本不会保存或上传。切到后台、离开取景页、打开面板或锁定读数时暂停取样。安卓会尝试硬件曝光。
- **画面分析**：显示测光区相对全画面的亮度差、直方图和高光裁切，关闭自动取样。
- **手动拍照测光**：拍摄或导入保留原始 EXIF 的 JPEG，选定测光区以及胶片 ISO，固定光圈或快门，即可看到胶片曝光组合。
- **硬件曝光（可选）**：仅在浏览器确认已启用手动曝光并返回有效快门和 ISO 时估算实时 EV。填写手机当前镜头的固定光圈。
- **校准**：在实时测光页点顶部状态 →「对照测光表」，填入参考光圈和快门或 EV100。自动 EXIF、硬件曝光和手动拍照分别保存校准值。

### 离线 / 安装 / 内嵌

- Service Worker 预缓存全部静态资源，断网可用；数据不依赖网络
- PWA 可安装到主屏幕（Android / iOS / 桌面）
- 纯静态、相对路径，可直接部署到 GitHub Pages 子路径
- 可被 Capacitor / Cordova / WebView 内嵌（见下文）

---

## 快速开始

```bash
npm start          # 启动本地静态服务器 → http://localhost:5173
npm test           # 曝光数学 + 亮度统计 + 数据层测试
npm run verify     # JS 语法 / DOM id / 静态资源 / manifest / SW 校验
```

> **必须通过 `https://` 或 `http://localhost` 打开。** 浏览器的相机与 Service Worker 都要求安全上下文，直接双击 `index.html`（`file://`）无法工作。

没有相机时可以在桌面预览：

```
http://localhost:5173/?demo=1
```

### 调试 / 演示参数

| 参数 | 作用 |
| --- | --- |
| `?demo=1` | 进入演示模式：程序绘制风景，不需要相机，可直接体验测光与保存 |
| `?skipintro=1` | 跳过首次引导 |
| `#log` / `#settings` | 直接打开记录 / 设置页 |

---

## 测光原理（以及它为什么会准 / 会不准）

### 1. 数据来源

**实时画面分析**用选区和全画面的线性亮度比来表示画面明暗差。手机会自动调整曝光，使不同光照下的预览仍有相似的亮度。该模式使用画面内的相对读数。

**拍照测光与硬件曝光**使用拍摄时的光圈、快门、ISO 作为曝光基准：

```
EV100 ≈ log2(N² / t) − log2(S / 100) + log2(L / 0.18) + 校准
```

- 拍照测光从 JPEG EXIF 读取手机镜头的固定光圈和实际曝光参数。尽量关闭闪光，选择同一光线下的均匀中间调。HDR、夜景、相机色调处理及裁切会影响估算。
- 硬件曝光由浏览器提供可验证的手动快门和 ISO，手机镜头光圈在设置中填写。使用其他镜头后重新核对光圈。
- 胶片 ISO 和胶片机光圈属于最终曝光换算，独立于手机拍照时使用的参数。

### 2. 画面亮度

1. `canvas.drawImage` 按取景框比例裁切（含数码变焦），缩放到 256–320px；
2. 用 sRGB EOTF LUT 把像素解码为**线性光**；
3. 计算 Rec.709 亮度 `Y = 0.2126R + 0.7152G + 0.0722B`；
4. 用 log2 亮度直方图（128 bin）统计均值、2/10/50/90/98 百分位、溢出比例；
5. 按模式对区域加权（圆形羽化 / 方形 / 高斯 / 全画面）。

### 3. 测光模式与 Zone

Zone 系统里 ZONE V = 18% 中灰，每 Zone 相差 1 EV。点测光把被测区域放到你选的目标影调：

```
EV推荐 = EV区域 − (目标Zone − 5)
```

- 高光优先：`EV = EV(p98) − 3`（放到 ZONE VIII）
- 暗部优先：`EV = EV(p02) + 2`（放到 ZONE III）

### 4. 推荐快门

光圈优先（默认，光圈由你设定）：

```
EV_S = EV100 + log2(S/100)
t    = N² / 2^(EV_S − ND档数)
```

快门优先（快门由你设定，光圈由测光反解）：

```
N = √( t × 2^(EV100 + log2(S/100) − ND档数) )
```

结果按相机常见的 1/3 档序列取整显示，同时保留精确值；超出常见档位时显示精确值并提示。

### 5. 校准

同一光线下对准同一张灰卡，分别用参考测光表和 LightNo 读取 EV100。在取景页点顶部状态 →「对照测光表」，用同一 ISO 输入参考曝光组合，也可输入参考 EV100。面板固定打开时的读数。用相同手机镜头和相机设置，在暗处、阴影和日光下复测，才能判断误差是否适合自己的胶片。校准偏移保存在本机，并且只修正常见偏差。

---

## 使用指南

1. 在手机上通过 HTTPS 打开页面并允许相机访问。
2. 设定胶片 ISO，并固定胶片机的光圈或快门。安卓硬件测光需填写手机当前镜头的固定光圈。
3. 对准被测区域并等读数刷新。iPhone 的刷新速度与取样耗时有关，缺少 EXIF 或样本过期时会暂停显示胶片曝光建议。
4. 如果设备不支持实时测光，可以用「拍照计算胶片曝光」或「导入原片」手动估算。

### ND 长曝光

1. 在曝光栏点 ND，选择你实际安装的减光镜；
2. 推荐快门自动变成「装 ND 后可直接使用」的值；
3. 超过 60s 会以秒 / 分钟显示，配合三脚架与快门线使用。

### 记录与备份

- 「记录」页点任意条目查看带参数照片、添加备注、收藏、下载
---

## 部署到 GitHub Pages

项目没有构建步骤，所有路径都是相对路径（`./`），可以直接放在仓库根目录或任意子目录。

```bash
git init
git add .
git commit -m "LIGHTNO light meter"
git branch -M main
git remote add origin git@github.com:<你的用户名>/lightno.git
git push -u origin main
```

然后在 GitHub 仓库：

1. **Settings → Pages**
2. Source 选 **Deploy from a branch**
3. Branch 选 **main**，目录选 **/ (root)**
4. 保存后访问 `https://<你的用户名>.github.io/lightno/`

### 更新版本时

修改任何前端文件后，请把 `sw.js` 顶部的版本号加一：

```js
const VERSION = 'lightno-v1.0.1';
```

Service Worker 会建立新缓存、清理旧缓存，并在页面上弹出「LIGHTNO 有新版本 → 刷新」。如果不改版本号，已安装的用户可能继续使用旧缓存。

> 自定义域名、HTTPS、子路径部署都不需要额外配置。GitHub Pages 默认 HTTPS，满足相机与 Service Worker 的安全上下文要求。

---

## 安装与离线

- **Android Chrome**：菜单 →「安装应用 / 添加到主屏幕」
- **iOS Safari**：分享 →「添加到主屏幕」  
  建议先在 Safari 标签页里完成一次相机授权，再添加到主屏幕。
- **桌面 Chrome / Edge**：地址栏右侧安装图标，或设置页「安装到桌面」

首次成功加载后，Service Worker 会缓存全部 HTML / CSS / JS / 图标。之后断网仍然可以：

- 启动应用与进入演示模式
- 使用相机测光（不依赖网络）
- 保存、浏览、备注、导出测光记录

**不会离线**的部分：无（应用没有后端）。

记录保存在浏览器的 IndexedDB 中。系统在存储空间不足或用户清理站点数据时可能清除它，请定期导出 JSON 备份。

---

## 内嵌到 App（WebView / Capacitor / Cordova）

LIGHTNO 是纯静态站点，可以直接作为 App 的本地页面使用。要点：

### 1. 必须通过安全上下文加载

`getUserMedia` 与 Service Worker 需要 `https://`、`http://localhost` 或平台认可的本地 scheme。**不要用 `file://` 直接加载**，否则相机与离线缓存都不可用。

推荐做法：

- **Capacitor**：把静态文件放进 `www/`，使用内置本地服务器（Android 为 `https://localhost`，iOS 为 `capacitor://localhost`）
- **Cordova**：`cordova-plugin-ionic-webview` 提供的 `https://localhost`
- **自建 WebView**：用 `WebViewAssetLoader`（Android）或本地 HTTP 服务加载

### 2. 权限声明

- **Android**：`AndroidManifest.xml` 增加
  ```xml
  <uses-permission android:name="android.permission.CAMERA" />
  ```
  WebView 还需处理 `onPermissionRequest`（授予 `RESOURCE_VIDEO_CAPTURE`）。
- **iOS**：`Info.plist` 增加
  ```xml
  <key>NSCameraUsageDescription</key>
  <string>用于摄影测光</string>
  ```
  WKWebView 需要 `allowsInlineMediaPlayback = true`，并允许自动播放（`mediaTypesRequiringUserActionForPlayback = []`）。

### 3. Capacitor 示例

```bash
npm i -D @capacitor/cli
npx cap init LIGHTNO com.example.lightno --web-dir=www
npx cap add android
npx cap add ios
npx cap sync
npx cap open android   # 或 ios
```

`capacitor.config.json`：

```json
{
  "appId": "com.example.lightno",
  "appName": "LIGHTNO",
  "webDir": "www",
  "server": {
    "androidScheme": "https"
  },
  "android": {
    "allowMixedContent": false
  }
}
```

UI 已经处理了安全区、`100dvh`、横屏与触控手势，WebView 内不需要额外适配。

### 4. 离线策略

App 内嵌时静态文件本来就打包在安装包里，Service Worker 属于锦上添花。如果 WebView 不支持 SW（例如自定义 `file://` 加载），**核心测光与 IndexedDB 记录仍然可用**，只是无法安装为 PWA。

### 5. 想要更准的 iOS 读数？

**先试「拍照测光」**：用系统相机拍一张 JPEG 原片。网页从原片 EXIF 读取手机的快门、固定光圈和 ISO，再根据测光区估算曝光并换算胶片机参数。

如果要做完全实时的原生级测光，可以用 Capacitor / Cordova 插件读取 `AVCaptureDevice` 的曝光参数，再通过 `evaluateJavascript` 把「当前相机快门 / ISO / 光圈」注入页面。LIGHTNO 的测光数学、UI、记录层都不需要改。

> iOS 相机默认 HEIC 时，Safari 的文件输入有时会转成 JPEG，有时会保留 HEIC。若拍照测光提示没有 EXIF，请在「设置 → 相机 → 格式」选择「兼容性最佳」。不要用截图或聊天软件转存的图片。

---

## 浏览器兼容与已知限制

| 平台 / 浏览器 | 相机手动曝光 | LIGHTNO 行为 |
| --- | --- | --- |
| Android Chrome | 视设备而定 | 支持手动曝光时默认使用硬件测光 |
| Safari 18.4+（iPhone / iPad） | 预览流不提供 | 默认尝试低频取样读取 EXIF，实际可用性取决于设备 |
| 桌面 Chrome / Edge | USB 摄像头有时支持 | 画面分析和导入原片；支持手动曝光时可试硬件曝光 |
| Firefox / 其他 | 约束支持有限 | 图像测光 + 拍照测光 |

### 限制（请务必了解）

1. **只有反射式测光**：没有入射式测光球，也没有闪光测光。
2. **手机镜头光圈**：拍照测光读原片 EXIF；硬件曝光需填写当前手机镜头的固定光圈。
3. **预览不是 RAW**：手机相机的预览有色调曲线与降噪，极暗 / 极亮时会偏离线性。
4. **色温是估算**：基于整幅画面平均 RGB 的 McCamy 近似，并受自动白平衡影响。
5. **自动曝光预览**：实时像素只能反映相对明暗。iPhone 自动取样时用同一张样本的 JPEG 和 EXIF 估算曝光。
6. **拍照测光依赖 EXIF**：截图、聊天软件转存、HEIC 或部分编辑过的照片可能没有快门 / 光圈 / ISO；请用系统相机拍摄 JPEG。
7. **相机曝光有物理极限（仅硬件引擎）**：AE 循环会在快门 / ISO 范围内收敛，超出范围时读数仍可计算，但预览可能溢出。
8. **无头浏览器 / 隐私模式**：部分环境会禁用 IndexedDB，应用会提示「本地数据库打开超时」，此时仍可测光，但无法保存记录。
9. **不替代专业测光表**：用于快速估光、外拍参考、胶片 / 大画幅的现场记录；商业拍摄请以校准后的专业设备为准。

---

## 项目结构

```
.
├── index.html                  # 单页应用骨架（测光 / 记录 / 设置）
├── manifest.webmanifest        # PWA 清单
├── sw.js                       # Service Worker（离线缓存，改版本号）
├── server.mjs                  # 零依赖本地静态服务器（npm start）
├── css/
│   ├── theme.css               # 设计令牌、基础样式、动效
│   ├── layout.css              # App 骨架、取景台、抽屉、响应式
│   └── components.css          # 按钮、读数、曝光单元、列表、Toast…
├── js/
│   ├── main.js                 # 入口：视图路由、引导、相机生命周期
│   ├── pwa.js                  # SW 注册、安装提示、离线状态
│   ├── core/
│   │   ├── exposure.js         # EV / ND / Zone / 色温 / 格式化（纯函数）
│   │   ├── sampler.js          # 线性亮度、区域统计、直方图、溢出图
│   │   ├── camera.js           # getUserMedia、手动曝光、变焦
│   │   ├── state.js            # 设置持久化 + 运行时状态 + 订阅
│   │   ├── store.js            # IndexedDB 测光记录仓库（带超时）
│   │   ├── capture.js          # 带参数照片合成（Canvas）
│   │   ├── exif.js             # JPEG EXIF 读取（快门 / 光圈 / ISO）
│   │   ├── demo.js             # 程序绘制的演示场景
│   │   └── wake.js             # 屏幕常亮
│   └── ui/
│       ├── meter.js            # 测光主控：采样、AE、读数、保存
│       ├── photoMeter.js       # 拍照测光：EXIF + 区域亮度 + 保存
│       ├── gestures.js         # 拖动 / 缩放 / 捏合手势
│       ├── pickers.js          # ISO / 光圈 / ND / Zone / 校准 / 说明
│       ├── history.js          # 记录列表、详情、备份导入导出
│       ├── settings.js         # 设置页
│       ├── sheet.js            # 底部抽屉
│       ├── toast.js            # 提示
│       ├── haptic.js           # 触感反馈
│       └── dom.js              # DOM / 格式化工具
├── assets/icons/               # PWA 图标（tools/make-icons.mjs 生成）
├── tools/
│   ├── make-icons.mjs          # 纯 Node PNG 图标生成器
│   └── verify.mjs              # 静态校验
└── tests/
    ├── run.mjs                 # 曝光数学 + 测光统计
    ├── store.test.mjs          # 数据层（内存版 IndexedDB）
    ├── exif.test.mjs           # JPEG EXIF 读取
    └── fake-idb.mjs            # 测试替身
```

---

## 测试与校验

```bash
npm test        # 18 个曝光 / 统计断言 + 5 个数据层断言 + 4 个 EXIF 断言
npm run verify  # 23 个 JS 文件语法、116 个 DOM id、静态资源、SW 预缓存、manifest
npm run icons   # 重新生成 180 / 192 / 512 / maskable 图标
```

`tools/verify.mjs` 会检查：

- 所有 JS 能否按 ES Module 解析
- `$('#id')` / `getElementById` 引用的 DOM 节点是否在 HTML 或 JS 模板里存在
- `index.html` 引用的本地文件是否存在
- `sw.js` 预缓存列表中的文件是否存在
- `manifest.webmanifest` 是否为合法 JSON、图标是否存在

> 本机无头 Edge 会禁用 IndexedDB，因此自动化截图环境下「记录」页会显示超时提示；真实浏览器不受影响，数据层已用内存替身单独测试。

---

## 数据与隐私

- 相机画面只在内存中处理，**不上传**
- 测光照片与参数写入本机 IndexedDB；设置写入 localStorage
- 地理位置是可选开关，只在保存时请求一次，写入该条记录
- 没有账号、没有统计 SDK、没有外部字体 / CDN
- 导出备份由你手动触发，文件留在本机

---

## Roadmap

- [x] 拍照测光：原片 EXIF + 选区亮度 → 胶片曝光建议
- [ ] iOS / Android 原生插件：实时读取 `exposureTime` / ISO / 光圈，获得原生级实时绝对测光
- [ ] 入射式测光（白球 / 灰卡辅助）
- [ ] 闪光测光（声控 / 屏幕同步）
- [ ] 胶片 reciprocity 补偿表
- [ ] 多点测光 / 场景动态范围图
- [ ] CSV 导出与拍摄参数对比
- [ ] 专业色温 / Tint 读数

---

## License

MIT
