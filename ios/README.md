# LightNo iPhone 原生版

App 内置与网页版共用的 HTML、CSS 和 JavaScript。Swift 使用 AVFoundation 固定后置主摄，只用视频流测光。预览帧在内存中传给界面。点按「保存」时，App 会把当前取景帧与测光读数写入本机的「记录」。等效曝光组合可点按选择并锁定。取景框的「分区」按钮可显示相对测光读数的 Zone 估算。

## 安装到 iPhone 13 Pro

1. 在带 iOS SDK 的完整 Xcode 中打开仓库下的 `ios/LightNo.xcodeproj`。此版支持 iOS 16 及以上的 iPhone，界面采用竖屏。
2. 在 Xcode 登录 Apple 账户，选择 LightNo target，在 **Signing & Capabilities** 选 Team 并保留自动签名。如果默认 Bundle Identifier 冲突，换成自己的标识。
3. 连接并解锁 iPhone。按提示配对并开启开发者模式。选择 **LightNo** scheme 和你的 iPhone，点击 **Run**。
4. 允许相机权限，设定胶片 ISO 和要固定的光圈或快门。对准均匀受光的灰卡，点顶部「原生测光」可看到手机相机的原始曝光参数，也可进入「对照测光表」。在不同光线下各比较一次，再判断是否要保存固定校准偏移。

App 等后置主摄曝光稳定后，用实际快门、ISO 和镜头光圈换算 EV100。原生校准的初始偏移为零，与网页版分别保存。点测光使用选区中心的相机曝光读数。其他模式以相机测光点周围一小块为亮度参考，按取景范围内的区域亮度修正 EV。这个修正基于经过手机处理的预览，遇到严重裁切时提示读数不稳定。ND 另行影响胶片快门。

## Camera host contract

`js/core/nativeCamera.js` is the common adapter. The app registers `window.LightNoHost = { version: 1, send(message) }` before the page modules load. An Android WebView host can implement the same transport with Camera2 capture results. The UI, exposure math and settings remain shared.

- Requests from the UI use a numeric `session` and a `type` of `start`, `stop`, `nextFrame` or `meterPoint`. The latter carries `x` and `y` in normalized portrait preview coordinates plus an increasing `revision`. The host maps those coordinates to its sensor. The separate `keepAwake` request contains only `enabled`. Hosts may accept an optional `fps` on `start` and the `previewRate` request to reduce delivery during HOLD.
- The host sends a `lightno-native-camera` CustomEvent with a `detail` containing the same `session` and a `type` of `ready`, `frame`, `paused` or `error`. Errors carry a `code`, user-facing `message` and optional `hint`.
- Each `nextFrame` allows at most one `frame`, with an in-memory `frameURL` on iOS or a transient base64 `jpeg` on other hosts, applied `revision` and `exposure`. Exposure is null or contains `shutter` in seconds, `iso`, `aperture` as an f-number, `offset` in stops from the camera exposure target, `adjusting` and `pointSupported`. Revisions and sessions prevent an old frame from updating a new measurement.
- The host owns permissions, camera setup, and stopping capture in the background. The adapter expires stale exposure readings. The shared UI composes and saves a preview snapshot on the user’s explicit save action.
