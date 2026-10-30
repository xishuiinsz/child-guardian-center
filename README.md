# child-guardian-center

## 核心需求
- 本程序的目标是管控作为普通用户的孩童单次使用电脑的时长，并强制休息数倍于使用电脑时长的时间。
- 本程序分多个版本实现
- 第1个版本主要能力：
    * 硬编码初始化用户的可用时长及禁用倍数
    * 以用户为维度，定义`UserTiming`接口，接口定义如下
    * status，字符串类型，表示当前用户是可用状态或禁用状态
    * countdown, 数字类型，时间戳格式，表示当前用户在当前状态下的时长
    * lastTime, 数字类型，时间戳格式，表示当前用户在当前状态下的时间点
    * 编写overTimeCheck函数，处理锁屏、定时器、更新状态等
    * 监听锁屏事件，如果在可用状态下锁屏，则停止定时器
    * 监听解锁事件，清除定时器，重新调用overTimeCheck


## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
