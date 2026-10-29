# 发布与分享

这个项目是**纯静态站点**，不需要后端、数据库或构建步骤。把整个目录原样上传到任意支持 HTTPS 的静态托管即可。

> 摄像头权限只在 HTTPS 或 `localhost` 下可用。`file://` 直接打开、或 HTTP 公网地址，都无法调用摄像头。

## 方案一：Netlify Drop（最快，推荐先试）

适合：想尽快把链接发给朋友，不想配置 Git。

1. 打开 <https://app.netlify.com/drop>，登录 Netlify。
2. 把 `D:\ai协作\好玩的` **整个文件夹**拖进页面。
3. 等待上传完成，会得到一个 `https://随机名.netlify.app` 地址。
4. 在 Site configuration → Change site name 改成好记的名字。
5. 手机打开该地址，点「授权摄像头 · 开启体验」，允许摄像头。

注意：

- 必须上传整个文件夹，不能只传 `index.html`；`js/`、`vendor/`、`models/` 都要在。
- 根目录要能看到 `index.html`。如果上传后地址是 `.../好玩的/index.html`，说明多套了一层文件夹。
- 项目里的 `_headers` 会被 Netlify 自动读取，用来给 wasm/模型设置正确的 MIME 和长期缓存。
- 以后更新：重新拖一次文件夹，或把项目接到 Git 自动部署。

## 方案二：Cloudflare Pages（长期公开，流量更宽松）

适合：希望长期使用、访问量较大、想绑定自己的域名。

1. 把项目推到 GitHub（或直接在 Cloudflare 里选 Direct Upload）。
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages**。
3. 连接 Git 仓库；没有框架，构建命令留空，输出目录填 `/`（或 `.`）。
4. 部署完成后得到 `https://项目名.pages.dev`。
5. 可在 Custom domains 绑定自己的域名，HTTPS 自动配置。

说明：

- Cloudflare Pages 单文件上限 25 MiB；本项目最大的 wasm 约 9.4 MB、模型约 7.8 MB，没有问题。
- `_headers` 同样支持，缓存和 wasm MIME 会生效。
- 国内访问 `*.pages.dev` 仍可能不稳定；面向大量大陆用户时看下面的「国内托管」。

## 方案三：GitHub Pages（免费、代码托管一体）

适合：项目本来就要开源，访问量不大。

1. 新建 GitHub 仓库，把项目文件上传到仓库根目录。
2. 仓库 Settings → Pages → Build and deployment：
   - Source: **Deploy from a branch**
   - Branch: `main`，目录 `/ (root)`
3. 保存后访问 `https://用户名.github.io/仓库名/`。
4. 项目里的 `.nojekyll` 会让 GitHub Pages 跳过 Jekyll 处理。

注意：

- 本项目所有资源路径都是相对路径，放在仓库子路径下也能正常工作。
- GitHub Pages 不支持 `_headers` 自定义响应头；通常它也能正确返回 `.wasm`，如果控制台报 wasm MIME 错误，优先换 Cloudflare Pages 或 Netlify。
- 仓库和 Pages 都是公开的，不要放隐私文件。

## 临时给朋友看：Cloudflare Tunnel

不想先注册托管、只想立刻生成一个临时 HTTPS 链接：

```powershell
# 先安装 cloudflared，然后保持本地服务运行
cloudflared tunnel --url http://127.0.0.1:8123
```

命令会输出一个 `https://....trycloudflare.com` 地址，发给朋友即可。关掉终端或电脑休眠后链接失效，适合临时演示，不适合长期发布。

## 面向中国大陆用户

如果主要用户在大陆，Netlify / Vercel / GitHub Pages 的访问速度和稳定性都可能不理想。更稳妥的方式：

- 阿里云 OSS / 腾讯云 COS 开启「静态网站托管」，前面套 CDN 并配置 HTTPS。
- 绑定自定义域名到大陆节点通常需要 **ICP 备案**；没有备案可先用香港/新加坡区域，但速度会下降。
- 上传后确认 `.wasm` 的 `Content-Type` 是 `application/wasm`，模型文件能正常访问。

## 部署前检查清单

- [ ] 站点根目录有 `index.html`
- [ ] `js/`、`css/`、`vendor/`、`models/` 目录结构完整
- [ ] 通过 HTTPS 访问（不是 `file://`，不是普通 HTTP 公网地址）
- [ ] 手机端允许摄像头后，页面能从「等待」进入「跟踪」
- [ ] 控制台没有 404，特别是 `models/hand_landmarker.task`
- [ ] 首次加载约 18–20 MB（模型 + wasm），需要一点时间；之后会走缓存
- [ ] 如果嵌入 iframe，必须加 `allow="camera; fullscreen"`

## 常见问题

**打开是黑屏/一直加载？**
看浏览器 Console 和 Network：通常是资源路径不对（只上传了 index.html），或服务器没把 `vendor/`、`models/` 一起发布。

**摄像头没有反应？**
确认地址是 `https://`；在浏览器站点设置里允许摄像头；iOS Safari 需要用户点击按钮后才能请求权限。

**MediaPipe 报 wasm 相关错误？**
检查 `vendor/mediapipe/wasm/` 是否完整，以及服务器返回的 `Content-Type: application/wasm`。本项目的 `_headers` 在 Netlify / Cloudflare Pages 上会自动处理。

**模型 404？**
确认 `models/hand_landmarker.task` 已上传，且路径大小写一致。

**首次打开很慢？**
模型约 7.8 MB，wasm 约 9.4 MB，属于正常体积。托管平台的 CDN 和浏览器缓存会改善第二次访问。
