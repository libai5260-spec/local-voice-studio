#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

function finish_install {
  local install_result=$?
  if [[ $install_result -ne 0 ]]; then
    echo "准备未完成。请查看上方提示；已下载的模型分段会保留，可再次运行继续。"
  fi
  if [[ -t 0 ]]; then
    read "?按回车关闭此窗口…" || true
  fi
}
trap finish_install EXIT

echo "Voice Studio — 首次安装"
echo "所有运行组件和模型保存在本项目内，不修改系统 Python。"
echo "1. Fish 高品质模型（默认，约 11 GB；需要 Python 3.12/3.13、Apple 芯片 Mac、建议 24 GB 内存）"
echo "2. Chatterbox 备用模型（约 1.9 GB；不需要 Python）"
echo "3. 仅准备网站组件（不下载模型，不能生成语音）"
echo "Fish 需要另行阅读并确认许可；不确认不会下载。建议预留至少 25 GB 空间。"
if [[ ! -t 0 ]]; then
  echo "请双击此文件或在终端交互运行。未进行安装。"
  exit 1
fi
read "INSTALL_CHOICE?请选择 1/2/3（回车选 1）："
INSTALL_CHOICE="${INSTALL_CHOICE:-1}"
case "$INSTALL_CHOICE" in
  1|2|3) ;;
  *) echo "未选择有效项目，已取消。"; exit 1 ;;
esac

/bin/zsh "$PROJECT_DIR/启动声音工作室.command" --prepare-only
export PATH="$PROJECT_DIR/.runtime/node/bin:$PATH"
case "$INSTALL_CHOICE" in
  1)
    /bin/sh "$PROJECT_DIR/scripts/fish-install.sh"
    /bin/sh "$PROJECT_DIR/scripts/fish-download.sh"
    ;;
  2)
    /bin/zsh "$PROJECT_DIR/scripts/download-voice-model.sh"
    ;;
esac
echo "准备完成。现在请双击「启动声音工作室.command」打开网站。"
echo "Fish 首次载入仍需等待模型读取；状态达到「已就绪」后才能开始生成。"
