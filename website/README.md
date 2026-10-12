# 字在 · 网站首页 / Zizai Website

在线地址：<https://zizai.io>

字在是一款中文和日文混着打、不用切换的输入法。这里是它的网站首页：一幅水墨画面，演示在中文句子里用日语读音打一个词、在日文句子里用拼音打一个词，背景随语种在竹林和樱花林之间转换。

*Zizai (字在) is an input method for typing Chinese and Japanese without switching. This directory holds its landing page, live at <https://zizai.io>: an ink-wash scene that turns between a bamboo grove and a cherry-blossom grove as the typed language changes.*

## 需要什么

- **浏览器**：支持 WebGPU 的浏览器；不支持时自动改用 WebGL2。
- **构建**：Node.js（在 22 上构建过），`npm install`（只有 terser 一个依赖）。
- **只有改 C++ 绘制代码时才需要**：clang++ 18 和 wasm-ld 18，用环境变量 `ZIZAI_CLANG`、`ZIZAI_WASM_LD` 指给 `site/build/native.mjs`。仓库里已带编译好的 `.wasm`。

## 构建与运行

```sh
npm install
npm run build      # 生成 site/dist/
npm run serve      # 本地服务器，http://127.0.0.1:8791
```

`site/dist/` 里有两种交付：

- `index.html`、`probe.worker.js` 与 `ordinary/`、`shared/`：放在服务器上用。`shared/` 使用共享内存，需要服务器给入口页、`probe.worker.js` 和 `shared/` 发送 `headers.json` 里写的两个隔离响应头；没有这两个头时自动使用 `ordinary/`。放在 Cloudflare Pages 上时，把 `site/deploy/_headers` 一起放进上传的目录即可。
- `single.html`：所有资源都在一个文件里，可直接打开。

## 网址开关

写在网址的 `#` 后面，多个用 `&` 连接。

| 开关 | 作用 |
|---|---|
| `renderer=webgpu` / `renderer=webgl` | 指定绘制方式，默认自动 |
| `open=zh` / `open=ja` | 指定以竹林或樱花林开场，默认按浏览器语言（中文为竹林，日语和英语为樱花林） |
| `seed=N` | 固定景物的随机种子，默认每次打开都不同 |
| `parallax=0`、`tilt=0` | 关闭随鼠标、随手机倾斜的视差 |
| `res=N` | 指定渲染的像素倍率 |

## 目录

| 位置 | 内容 |
|---|---|
| `site/src/main` | 打字演示、版面、与渲染线程的通信 |
| `site/src/render` | WebGPU 与 WebGL2 两套绘制：合成、文字、界面、飘落的叶与花瓣、景物图块 |
| `site/src/generate` | 生成景物的线程 |
| `site/src/native` | C++ 源码：竹、樱、远山的画法和动画计算，编译为 WebAssembly |
| `site/src/html` | 页面骨架与样式 |
| `site/assets` | 字体子集和编译好的 `.wasm` |
| `site/deploy/_headers` | Cloudflare Pages 用的响应头规则 |
| `tools/github-brush.html` | 画左下角按钮用的离线毛笔模拟，在浏览器里打开即运行 |

## 许可

代码与画面以 [MIT 许可](LICENSE) 发布。

第三方内容各按自己的许可：

- 字体 Noto Serif SC、Shippori Mincho、Cormorant Garamond、Ma Shan Zheng、Yuji Syuku 以 SIL Open Font License 1.1 发布，许可全文在 `licenses/fonts/`；页面里嵌入的是只含所用字符的子集。
- GitHub 标记是 GitHub 的商标，这里只用于指向 GitHub 的链接。
