# APK 构建说明书（本机环境专用）

> 目的：让本机**任何新项目、任何新任务**都能直接编译出安卓 APK，不再出现
> "缺少某某环境无法构建"的提示。本机环境已全部装好并验证可用，照抄本文命令即可。

---

## 一、本机已装好的环境（不用再装！）

| 组件 | 版本/说明 | 位置 | 状态 |
|---|---|---|---|
| JDK | 21（Android Studio 自带 JBR） | `D:\apps\androidstudio\jbr` | ✅ 可直接用 |
| Android SDK | android-36 / build-tools 36.1.0 / platform-tools(adb) | `D:\apps\androidSDK` | ✅ 可直接用 |
| Node.js | 22.22.2 | `C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | ✅ |
| Gradle | 8.11.1，**不需要单独装**，项目里的 wrapper 会自动下载 | 自动 | ✅ |
| 构建用户目录 | Gradle 缓存（避免 C 盘碎片） | 项目内 `.gradle-home/`（由 `GRADLE_USER_HOME` 指定） | ✅ |

**环境变量（已通过 setx 写入用户级，永久生效，新开的终端/任务自动拥有）：**

| 变量 | 值 |
|---|---|
| `JAVA_HOME` | `D:\apps\androidstudio\jbr` |
| `ANDROID_HOME` | `D:\apps\androidSDK` |
| `ANDROID_SDK_ROOT` | `D:\apps\androidSDK` |

> 验证方法：新开一个 cmd，敲 `echo %JAVA_HOME%`，能打印出路径就说明永久变量已生效。

---

## 二、编译 APK 三步走（以对讲机项目为例）

在项目根目录（`android` 文件夹的**上一级**）打开 cmd：

**第 1 步：Web 资源同步到安卓工程**（改了 `www/` 里的网页代码后必做）

```bat
npx cap sync android
```

**第 2 步：编译 debug APK**

```bat
cd android
gradlew.bat assembleDebug
```

**第 3 步：拿成品**

```
android\app\build\outputs\apk\debug\app-debug.apk
```

第一次编译会下载 Gradle 和依赖（约几百 MB，走国内镜像，视网速 10~30 分钟）；
**以后再编译就是增量秒级~分钟级**。编译完成的标志是 `BUILD SUCCESSFUL`。

改版本号发新版：`www/app.js` 顶部 `APP_VERSION/APP_BUILD` 和
`android/app/build.gradle` 里 `versionCode/versionName` **两处一起改**，再走上面三步。

---

## 三、新项目从零建 APK（开新任务时看这里）

最快路线是**复制本项目当模板**（推荐，所有镜像配置都是现成的）：

1. 复制 `walkie/` 整个文件夹到新项目目录（可不复制 `.gradle-home`、`node_modules`）
2. 改三处身份信息：
   - `capacitor.config.json` 里的 `appId`（新应用包名，如 `com.pangou.xxx`）和 `appName`
   - `android/app/build.gradle` 里的 `applicationId`、`versionCode/versionName`
   - `package.json` 的 `name`
3. 改 `www/` 里的前端代码（App 的界面逻辑全在这，纯网页技术）
4. 按"三步走"编译

从零新建（不用模板）时，除了官方 `npm init @capacitor` 流程，**必须**补以下两处国内适配，否则必然卡死在下载：

- `android/gradle/wrapper/gradle-wrapper.properties`：把 `distributionUrl` 换成
  `https://mirrors.cloud.tencent.com/gradle/gradle-8.11.1-bin.zip`
  （国内直连 `services.gradle.org` 必超时）
- `android/build.gradle`：在 `buildscript.repositories` 和 `allprojects.repositories`
  的**最前面**加阿里云镜像三行：

  ```groovy
  maven { url 'https://maven.aliyun.com/repository/google' }
  maven { url 'https://maven.aliyun.com/repository/public' }
  maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
  ```

---

## 四、踩坑对照表（实测教训，遇到先查这里）

| 症状 | 原因 | 解法 |
|---|---|---|
| 卡在 "Downloading gradle-x.x-bin.zip" 超时 | 官方源国内连不上 | 用第三节腾讯镜像配置 |
| 依赖下载失败 / Could not resolve | Maven 官方源慢 | 用阿里云镜像配置 |
| aapt2 编译报错 `resource color not found` | Capacitor 7 生成的工程缺 `values/colors.xml` | 手工补一个含 `ic_launcher_background` 颜色定义的文件 |
| `JAVA_HOME is not set` / 版本报错 | 没配环境变量或指向旧 JDK | 确认 `JAVA_HOME=D:\apps\androidstudio\jbr`（要 JDK 21） |
| 改了网页代码但 APK 里没生效 | 忘了 `npx cap sync android` | sync 后重新编译 |
| 覆盖安装失败 | versionCode 没加 | 新版本 versionCode 必须比上一版大 |

---

## 五、给 AI 助手的备注（新会话直接照此执行）

- 本机构建环境已就绪：JDK21=`D:\apps\androidstudio\jbr`，SDK=`D:\apps\androidSDK`，
  JAVA_HOME/ANDROID_HOME/ANDROID_SDK_ROOT 已 setx 永久写入用户环境变量。
- Gradle 不装系统级，一律用项目 wrapper；国内网络，必须腾讯云(gradle 分发)+阿里云(maven)镜像。
- bash 环境可 `source env.sh`（本仓库自带）；cmd 环境用 setx 后的永久变量即可。
- debug APK 产物路径：`android/app/build/outputs/apk/debug/app-debug.apk`。
- 模板工程：本仓库（Capacitor 7 + PTT 对讲机），新项目复制改造最快。
