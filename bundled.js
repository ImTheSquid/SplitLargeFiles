// index.jsx
module.exports = (Plugin, Library) => {
  "use strict";
  const { Logger, Patcher, WebpackModules, DiscordModules, DOMTools, PluginUtilities, ContextMenu, Settings } = Library;
  const { SettingPanel, Slider } = Settings;
  const { Dispatcher, React, SelectedChannelStore, SelectedGuildStore } = DiscordModules;
  const fileCheckMod = WebpackModules.getByProps("anyFileTooLarge", "maxFileSize");
  const fileUploadMod = WebpackModules.getByProps("instantBatchUpload", "upload");
  const channelMod = BdApi.findModuleByProps("getChannel", "getMutablePrivateChannels", "hasChannel");
  const messagesMod = BdApi.findModuleByProps("hasCurrentUserSentMessage", "getMessage");
  const guildMod = BdApi.findModuleByProps("getGuild");
  const guildIDMod = BdApi.findModuleByProps("getGuildId");
  const userMod = BdApi.findModuleByProps("getCurrentUser");
  const permissionsMod = BdApi.findModuleByProps("computePermissions");
  const deleteMod = BdApi.findModuleByProps("deleteMessage", "dismissAutomatedMessage");
  const MessageAccessories = WebpackModules.find((mod) => mod.MessageAccessories.displayName === "MessageAccessories");
  const Attachment = WebpackModules.find((m) => m.default?.displayName === "Attachment");
  const concatTypedArrays = (a, b) => {
    var c = new a.constructor(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  };
  const isSetLinear = (set) => {
    for (let setIndex = 0; setIndex < set.length; setIndex++) {
      if (!set.has(setIndex)) {
        return false;
      }
    }
    return true;
  };
  const convertFilenameToComponents = (name) => {
    const splitData = name.split(".");
    let reconstructedName = "";
    for (let i = 0; i < splitData.length - 1; i++) {
      reconstructedName += splitData[i];
    }
    return [reconstructedName, splitData[splitData.length - 1]];
  };
  function downloadFiles(download) {
    const https = require("https");
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const id = crypto.randomBytes(16).toString("hex");
    const tempFolder = fs.mkdtempSync(path.join(os.tmpdir(), `dlfc-download-${id}`));
    BdApi.showToast("Downloading files...", { type: "info" });
    let promises = [];
    for (const url of download.urls) {
      const chunkName = url.slice(url.lastIndexOf("/") + 1);
      const dest = path.join(tempFolder, chunkName);
      const file = fs.createWriteStream(dest);
      const downloadPromise = new Promise((resolve, reject) => {
        https.get(url, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve(chunkName);
          });
        }).on("error", (err) => {
          fs.unlink(dest);
          reject(err);
        });
      });
      promises.push(downloadPromise);
    }
    Promise.all(promises).then((names) => {
      let fileBuffers = [];
      for (const name of names) {
        fileBuffers.push(fs.readFileSync(path.join(tempFolder, name)));
      }
      fileBuffers = fileBuffers.filter((buffer) => buffer.length >= 5 && buffer[0] === 223 && buffer[1] === 0);
      fileBuffers.sort((left, right) => left[2] - right[2]);
      let numChunks = 0;
      let chunkSet = /* @__PURE__ */ new Set();
      let outputFile = fs.createWriteStream(path.join(tempFolder, `${download.filename}`));
      for (const buffer of fileBuffers) {
        if (buffer[2] >= buffer[3] || numChunks !== 0 && buffer[3] > numChunks) {
          BdApi.showToast("Reassembly failed: Some chunks are not part of the same file", { type: "error" });
          outputFile.close();
          return;
        }
        chunkSet.add(buffer[2]);
        numChunks = buffer[3];
        outputFile.write(buffer.slice(4));
      }
      if (!isSetLinear(chunkSet) || chunkSet.size === 0) {
        BdApi.showToast("Reassembly failed: Some chunks do not exist", { type: "error" });
        outputFile.close();
        return;
      }
      outputFile.close(() => {
        BdApi.showToast("File reassembled successfully", { type: "success" });
        DiscordNative.fileManager.saveWithDialog(fs.readFileSync(path.join(tempFolder, `${download.filename}`)), download.filename);
        fs.rmdirSync(tempFolder, { recursive: true });
      });
    }).catch((err) => {
      Logger.error(err);
      BdApi.showToast("Failed to download file, please try again later.", { type: "error" });
      fs.rmdirSync(tempFolder, { recursive: true });
    });
  }
  class AttachmentShim extends React.Component {
    constructor(props) {
      super(props);
      this.child = props.children;
      this.attachmentID = props.attachmentData.id;
      this.state = {
        downloadData: null
      };
      this.onNewDownload = this.onNewDownload.bind(this);
    }
    componentDidMount() {
      Dispatcher.subscribe("DLFC_REFRESH_DOWNLOADS", this.onNewDownload);
    }
    componentWillUnmount() {
      Dispatcher.unsubscribe("DLFC_REFRESH_DOWNLOADS", this.onNewDownload);
    }
    onNewDownload(e) {
      if (this.state.downloadData) {
        return;
      }
      for (const download of e.downloads) {
        if (download.messages[0].attachmentID === this.attachmentID) {
          this.setState({ downloadData: download });
          break;
        }
      }
    }
    render() {
      if (this.state.downloadData) {
        return React.createElement(Attachment.default, {
          filename: this.state.downloadData.filename,
          url: null,
          dlfc: true,
          size: this.state.downloadData.totalSize,
          onClick: () => {
            downloadFiles(this.state.downloadData);
          }
        }, []);
      } else {
        return this.child;
      }
    }
  }
  const defaultSettingsData = {
    deletionDelay: 9,
    uploadDelay: 9,
    uploadBatchSize: 3
  };
  let settings = null;
  const reloadSettings = () => {
    settings = PluginUtilities.loadSettings("SplitLargeFiles", defaultSettingsData);
  };
  const validActionDelays = [6, 7, 8, 9, 10, 11, 12];
  const validUploadBatchSizes = [...Array(11).keys()].slice(1);
  class SplitLargeFiles extends Plugin {
    onStart() {
      BdApi.injectCSS("SplitLargeFiles", `
                .dlfcIcon {
                    width: 30px; 
                    height: 40px; 
                    margin-right: 8px;
                }
            `);
      reloadSettings();
      this.registeredDownloads = [];
      this.incompleteDownloads = [];
      Patcher.instead(fileCheckMod, "anyFileTooLarge", (_, __, ___) => {
        return false;
      });
      Patcher.instead(fileCheckMod, "uploadSumTooLarge", (_, __, ___) => {
        return false;
      });
      Patcher.instead(fileCheckMod, "getUploadFileSizeSum", (_, __, ___) => {
        return 0;
      });
      Patcher.instead(fileCheckMod, "maxFileSize", (_, args, original) => {
        const [arg, use_original] = args;
        if (use_original) {
          return original(arg);
        }
        return Number.MAX_VALUE;
      });
      Patcher.instead(fileUploadMod, "upload", (_, args, original) => {
        const [channelId, file, n] = args;
        if (this.maxFileUploadSize() === 0) {
          BdApi.showToast("Failed to get max file upload size.", { type: "error" });
          return;
        }
        const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);
        if (numChunks == 1) {
          original(...args);
          return;
        } else if (numChunksWithHeaders > 255) {
          BdApi.showToast("File size exceeds max chunk count of 255.", { type: "error" });
          return;
        }
        BdApi.showToast("Generating file chunks...", { type: "info" });
        this.uploadLargeFiles([file], channelId, n);
      });
      Patcher.instead(fileUploadMod, "uploadFiles", (_, args, original) => {
        const [channelId, files, n, message, stickers] = args;
        if (this.maxFileUploadSize() === 0) {
          BdApi.showToast("Failed to get max file upload size.", { type: "error" });
          return;
        }
        let oversizedFiles = [];
        for (let fIndex = 0; fIndex < files.length; fIndex++) {
          const file = files[fIndex].item.file;
          const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);
          if (numChunks == 1) {
            continue;
          } else if (numChunksWithHeaders > 255) {
            BdApi.showToast("File size exceeds max chunk count of 255.", { type: "error" });
            return;
          }
          files.splice(fIndex, 1);
          oversizedFiles.push(file);
          fIndex--;
        }
        if (files.length > 0 || message.content.length > 0 || stickers.stickerIds.length > 0) {
          original(channelId, files, n, message, stickers);
        }
        if (oversizedFiles.length > 0) {
          this.uploadLargeFiles(oversizedFiles, channelId, n, oversizedFiles.length > 1);
        }
      });
      Patcher.after(MessageAccessories.MessageAccessories.prototype, "renderAttachments", (_, [arg], ret) => {
        if (!ret || arg.attachments.length === 0 || !arg.attachments[0].filename.endsWith(".dlfc")) {
          return;
        }
        const component = ret[0].props.children;
        ret[0].props.children = /* @__PURE__ */ React.createElement(AttachmentShim, {
          attachmentData: arg.attachments[0]
        }, component);
      });
      Patcher.after(Attachment, "default", (_, args, ret) => {
        ret.props.children[2].props.onClick = args[0].onClick;
        if (args[0].dlfc) {
          ret.props.children[0] = React.createElement("img", {
            className: "dlfcIcon",
            alt: "Attachment file type: SplitLargeFiles Chunk File",
            title: "SplitLargeFiles Chunk File",
            src: "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9Im5vIj8+CjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+Cjxzdmcgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgdmlld0JveD0iMCAwIDcyIDk2IiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHhtbDpzcGFjZT0icHJlc2VydmUiIHhtbG5zOnNlcmlmPSJodHRwOi8vd3d3LnNlcmlmLmNvbS8iIHN0eWxlPSJmaWxsLXJ1bGU6ZXZlbm9kZDtjbGlwLXJ1bGU6ZXZlbm9kZDtzdHJva2UtbGluZWpvaW46cm91bmQ7c3Ryb2tlLW1pdGVybGltaXQ6MjsiPgogICAgPHBhdGggZD0iTTcyLDI5LjNMNzIsODkuNkM3Miw5MS44NCA3Miw5Mi45NiA3MS41Niw5My44MkM3MS4xOCw5NC41NiA3MC41Niw5NS4xOCA2OS44Miw5NS41NkM2OC45Niw5NiA2Ny44NCw5NiA2NS42LDk2TDYuNCw5NkM0LjE2LDk2IDMuMDQsOTYgMi4xOCw5NS41NkMxLjQ0LDk1LjE4IDAuODIsOTQuNTYgMC40NCw5My44MkMwLDkyLjk2IDAsOTEuODQgMCw4OS42TDAsNi40QzAsNC4xNiAwLDMuMDQgMC40NCwyLjE4QzAuODIsMS40NCAxLjQ0LDAuODIgMi4xOCwwLjQ0QzMuMDQsLTAgNC4xNiwtMCA2LjQsLTBMNDIuNywtMEM0NC42NiwtMCA0NS42NCwtMCA0Ni41NiwwLjIyQzQ3LjA2LDAuMzQgNDcuNTQsMC41IDQ4LDAuNzJMNDgsMTcuNkM0OCwxOS44NCA0OCwyMC45NiA0OC40NCwyMS44MkM0OC44MiwyMi41NiA0OS40NCwyMy4xOCA1MC4xOCwyMy41NkM1MS4wNCwyNCA1Mi4xNiwyNCA1NC40LDI0TDcxLjI4LDI0QzcxLjUsMjQuNDYgNzEuNjYsMjQuOTQgNzEuNzgsMjUuNDRDNzIsMjYuMzYgNzIsMjcuMzQgNzIsMjkuM1oiIHN0eWxlPSJmaWxsOnJnYigyMTEsMjE0LDI1Myk7ZmlsbC1ydWxlOm5vbnplcm87Ii8+CiAgICA8cGF0aCBkPSJNNjguMjYsMjAuMjZDNjkuNjQsMjEuNjQgNzAuMzIsMjIuMzIgNzAuODIsMjMuMTRDNzEsMjMuNDIgNzEuMTQsMjMuNyA3MS4yOCwyNEw1NC40LDI0QzUyLjE2LDI0IDUxLjA0LDI0IDUwLjE4LDIzLjU2QzQ5LjQ0LDIzLjE4IDQ4LjgyLDIyLjU2IDQ4LjQ0LDIxLjgyQzQ4LDIwLjk2IDQ4LDE5Ljg0IDQ4LDE3LjZMNDgsMC43MkM0OC4zLDAuODYgNDguNTgsMSA0OC44NiwxLjE4QzQ5LjY4LDEuNjggNTAuMzYsMi4zNiA1MS43NCwzLjc0TDY4LjI2LDIwLjI2WiIgc3R5bGU9ImZpbGw6cmdiKDE0NywxNTUsMjQ5KTtmaWxsLXJ1bGU6bm9uemVybzsiLz4KICAgIDxnIHRyYW5zZm9ybT0ibWF0cml4KDEsMCwwLDEsNC41LDcpIj4KICAgICAgICA8cmVjdCB4PSIxMSIgeT0iNDEiIHdpZHRoPSI0MSIgaGVpZ2h0PSIyOCIgc3R5bGU9ImZpbGw6cmdiKDE0NywxNTUsMjQ5KTsiLz4KICAgIDwvZz4KICAgIDxnIHRyYW5zZm9ybT0ibWF0cml4KDEsMCwwLDAuNSwtMiwyMy41KSI+CiAgICAgICAgPHJlY3QgeD0iMjEiIHk9IjM5IiB3aWR0aD0iMTAiIGhlaWdodD0iMTAiIHN0eWxlPSJmaWxsOnJnYigxNDcsMTU1LDI0OSk7Ii8+CiAgICA8L2c+CiAgICA8ZyB0cmFuc2Zvcm09Im1hdHJpeCgxLDAsMCwwLjUsMjIsMjMuNSkiPgogICAgICAgIDxyZWN0IHg9IjIxIiB5PSIzOSIgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBzdHlsZT0iZmlsbDpyZ2IoMTQ3LDE1NSwyNDkpOyIvPgogICAgPC9nPgo8L3N2Zz4K"
          });
        }
      });
      this.messageCreate = (e) => {
        if (e.channelId !== this.getCurrentChannel()?.id) {
          return;
        }
        this.lastMessageCreatedId = e.message.id;
        this.findAvailableDownloads();
      };
      Dispatcher.subscribe("MESSAGE_CREATE", this.messageCreate);
      this.channelSelect = (_) => {
        setTimeout(() => this.findAvailableDownloads(), 200);
      };
      Dispatcher.subscribe("CHANNEL_SELECT", this.channelSelect);
      this.loadMessagesSuccess = (_) => {
        this.findAvailableDownloads();
      };
      Dispatcher.subscribe("LOAD_MESSAGES_SUCCESS", this.loadMessagesSuccess);
      ContextMenu.getDiscordMenu("MessageContextMenu").then((menu) => {
        Patcher.after(menu, "default", (_, [arg], ret) => {
          ret.props.children.splice(4, 0, ContextMenu.buildMenuItem({ type: "separator" }), ContextMenu.buildMenuItem({ label: "Refresh Downloadables", action: () => {
            this.findAvailableDownloads();
            BdApi.showToast("Downloadables refreshed", { type: "success" });
          } }));
          const incomplete = this.incompleteDownloads.find((download) => download.messages.find((message) => message.id === arg.message.id));
          if (incomplete && this.canDeleteDownload(incomplete)) {
            ret.props.children.splice(6, 0, ContextMenu.buildMenuItem({ label: "Delete Download Fragments", danger: true, action: () => {
              this.deleteDownload(incomplete);
              this.findAvailableDownloads();
            } }));
          }
        });
      });
      ContextMenu.getDiscordMenu("ChannelListTextChannelContextMenu").then((menu) => {
        Patcher.after(menu, "default", (_, [arg], ret) => {
          if (arg.channel.id === this.getCurrentChannel()?.id) {
            ret.props.children.props.children.splice(1, 0, ContextMenu.buildMenuItem({ type: "separator" }), ContextMenu.buildMenuItem({ label: "Refresh Downloadables", action: () => {
              this.findAvailableDownloads();
              BdApi.showToast("Downloadables refreshed", { type: "success" });
            } }));
          }
        });
      });
      this.messageDelete = (e) => {
        if (e.channelId !== this.getCurrentChannel()?.id) {
          return;
        }
        const download = this.registeredDownloads.find((element) => element.messages.find((message) => message.id == e.id));
        if (download && this.canDeleteDownload(download)) {
          this.deleteDownload(download, e.id);
        }
        this.findAvailableDownloads();
      };
      Dispatcher.subscribe("MESSAGE_DELETE", this.messageDelete);
      BdApi.showToast("Waiting for BetterDiscord to load before refreshing downloadables...", { type: "info" });
      setTimeout(() => {
        BdApi.showToast("Downloadables refreshed", { type: "success" });
        this.findAvailableDownloads();
      }, 1e4);
    }
    uploadLargeFiles(files, channelId, n, disableBatch = false) {
      BdApi.showToast("Generating file chunks...", { type: "info" });
      const batchSize = disableBatch ? 1 : settings.uploadBatchSize;
      for (const file of files) {
        file.arrayBuffer().then((buffer) => {
          const fileBytes = new Uint8Array(buffer);
          const [numChunks, numChunksWithHeaders] = this.calcNumChunks(file);
          const fileList = [];
          for (let chunk = 0; chunk < numChunksWithHeaders; chunk++) {
            const baseOffset = chunk * (this.maxFileUploadSize() - 4);
            const headerBytes = new Uint8Array(4);
            headerBytes.set([223, 0, chunk & 255, numChunks & 255]);
            const bytesToWrite = fileBytes.slice(baseOffset, baseOffset + this.maxFileUploadSize() - 4);
            fileList.push(new File([concatTypedArrays(headerBytes, bytesToWrite)], `${chunk}-${numChunks - 1}_${file.name}.dlfc`));
          }
          for (let i = 0; i < Math.ceil(fileList.length / batchSize); ++i) {
            setTimeout(() => fileUploadMod.instantBatchUpload(channelId, fileList.slice(i * batchSize, i * batchSize + batchSize), n), settings.uploadDelay * i * 1e3);
          }
        }).catch((err) => {
          Logger.error(err);
          BdApi.showToast("Failed to read file, please try again later.", { type: "error" });
        });
      }
      BdApi.showToast(`All files uploading (${batchSize} chunk${batchSize == 1 ? "" : "s"}/${settings.uploadDelay} seconds${disableBatch ? ", batch disabled" : ""})`, { type: "success" });
    }
    calcNumChunks(file) {
      return [Math.ceil(file.size / this.maxFileUploadSize()), Math.ceil(file.size / (this.maxFileUploadSize() - 4))];
    }
    getSettingsPanel() {
      reloadSettings();
      return new SettingPanel(() => {
        PluginUtilities.saveSettings("SplitLargeFiles", settings);
      }, new Slider("Chunk File Upload Batch Size", "Number of chunk files to queue per upload operation. Setting this higher uploads your files faster but increases the chance of upload errors.", validUploadBatchSizes[0], validUploadBatchSizes[validUploadBatchSizes.length - 1], settings.uploadBatchSize, (newVal) => {
        if (newVal > validUploadBatchSizes[validUploadBatchSizes.length - 1] || newVal < validUploadBatchSizes[0]) {
          newVal = validUploadBatchSizes[0];
        }
        settings.uploadBatchSize = newVal;
      }, { markers: validUploadBatchSizes, stickToMarkers: true }), new Slider("Chunk File Upload Delay", "How long to wait (in seconds) before uploading each chunk file batch. If you plan on uploading VERY large files you should set this value high to avoid API spam.", validActionDelays[0], validActionDelays[validActionDelays.length - 1], settings.uploadDelay, (newVal) => {
        if (newVal > validActionDelays[validActionDelays.length - 1] || newVal < validActionDelays[0]) {
          newVal = validActionDelays[0];
        }
        settings.uploadDelay = newVal;
      }, { markers: validActionDelays, stickToMarkers: true }), new Slider("Chunk File Deletion Delay", "How long to wait (in seconds) before deleting each sequential message of a chunk file. If you plan on deleting VERY large files you should set this value high to avoid API spam.", validActionDelays[0], validActionDelays[validActionDelays.length - 1], settings.deletionDelay, (newVal) => {
        if (newVal > validActionDelays[validActionDelays.length - 1] || newVal < validActionDelays[0]) {
          newVal = validActionDelays[0];
        }
        settings.deletionDelay = newVal;
      }, { markers: validActionDelays, stickToMarkers: true })).getElement();
    }
    maxFileUploadSize() {
      if (!fileCheckMod) {
        return 0;
      }
      return fileCheckMod.maxFileSize(SelectedGuildStore.getGuildId(), true) - 1e3;
    }
    findAvailableDownloads() {
      this.registeredDownloads = [];
      this.incompleteDownloads = [];
      for (const message of this.getChannelMessages(this.getCurrentChannel()?.id) ?? []) {
        if (message.noDLFC) {
          continue;
        }
        let foundDLFCAttachment = false;
        for (const attachment of message.attachments) {
          if (isNaN(parseInt(attachment.filename)) || !attachment.filename.endsWith(".dlfc")) {
            continue;
          }
          foundDLFCAttachment = true;
          const realName = this.extractRealFileName(attachment.filename);
          const existingEntry = this.registeredDownloads.find((element) => element.filename === realName && !element.foundParts.has(parseInt(attachment.filename)));
          if (existingEntry) {
            existingEntry.urls.push(attachment.url);
            existingEntry.messages.push({ id: message.id, date: message.timestamp, attachmentID: attachment.id });
            existingEntry.foundParts.add(parseInt(attachment.filename));
            existingEntry.totalSize += attachment.size;
          } else {
            this.registeredDownloads.unshift({
              filename: realName,
              owner: message.author.id,
              urls: [attachment.url],
              messages: [{ id: message.id, date: message.timestamp, attachmentID: attachment.id }],
              foundParts: /* @__PURE__ */ new Set([parseInt(attachment.filename)]),
              totalSize: attachment.size
            });
          }
        }
        if (!foundDLFCAttachment) {
          message.noDLFC = true;
        }
      }
      this.registeredDownloads = this.registeredDownloads.filter((value, _, __) => {
        const chunkSet = /* @__PURE__ */ new Set();
        let highestChunk = 0;
        for (const url of value.urls) {
          const filename = url.slice(url.lastIndexOf("/") + 1);
          const fileNumber = parseInt(filename);
          const fileTotal = parseInt(filename.slice(filename.indexOf("-") + 1));
          chunkSet.add(fileNumber);
          if (highestChunk === 0) {
            highestChunk = fileTotal;
          } else if (highestChunk !== fileTotal) {
            this.incompleteDownloads.push(value);
            return false;
          }
        }
        const result = isSetLinear(chunkSet) && highestChunk + 1 === chunkSet.size;
        if (!result) {
          this.incompleteDownloads.push(value);
        }
        return result;
      });
      this.registeredDownloads.forEach((download) => {
        download.messages.sort((first, second) => first.date - second.date);
        for (let messageIndex = 1; messageIndex < download.messages.length; messageIndex++) {
          this.setMessageVisibility(download.messages[messageIndex].id, false);
        }
      });
      if (this.registeredDownloads.length > 0) {
        Dispatcher.dirtyDispatch({
          type: "DLFC_REFRESH_DOWNLOADS",
          downloads: this.registeredDownloads
        });
      }
    }
    extractRealFileName(name) {
      return name.slice(name.indexOf("_") + 1, name.length - 5);
    }
    setMessageVisibility(id, visible) {
      const element = DOMTools.query(`#chat-messages-${id}`);
      if (element) {
        if (visible) {
          element.removeAttribute("hidden");
        } else {
          element.setAttribute("hidden", "");
        }
      } else {
        Logger.error(`Unable to find DOM object with selector #chat-messages-${id}`);
      }
    }
    deleteDownload(download, excludeMessage = null) {
      BdApi.showToast(`Deleting chunks (1 chunk/${settings.deletionDelay} seconds)`, { type: "success" });
      let delayCount = 1;
      for (const message of this.getChannelMessages(this.getCurrentChannel().id)) {
        const downloadMessage = download.messages.find((dMessage) => dMessage.id == message.id);
        if (downloadMessage) {
          if (excludeMessage && message.id === excludeMessage.id) {
            continue;
          }
          this.setMessageVisibility(message.id, true);
          const downloadMessageIndex = download.messages.indexOf(downloadMessage);
          download.messages.splice(downloadMessageIndex, 1);
          setTimeout(() => this.deleteMessage(message), delayCount * settings.deletionDelay * 1e3);
          delayCount += 1;
        }
      }
    }
    canDeleteDownload(download) {
      return download.owner === this.getCurrentUser().id || this.canManageMessages();
    }
    getCurrentChannel() {
      return channelMod.getChannel(SelectedChannelStore.getChannelId()) ?? null;
    }
    getChannelMessages(channelId) {
      if (!channelId) {
        return null;
      }
      return messagesMod.getMessages(channelId)._array;
    }
    getCurrentUser() {
      return userMod.getCurrentUser();
    }
    canManageMessages() {
      const currentChannel = this.getCurrentChannel();
      if (!currentChannel) {
        return false;
      }
      return !!(permissionsMod.computePermissions(currentChannel) & 0x2000n);
    }
    deleteMessage(message) {
      deleteMod.deleteMessage(message.channel_id, message.id, false);
    }
    onStop() {
      Patcher.unpatchAll();
      Dispatcher.unsubscribe("MESSAGE_CREATE", this.messageCreate);
      Dispatcher.unsubscribe("CHANNEL_SELECT", this.channelSelect);
      Dispatcher.unsubscribe("MESSAGE_DELETE", this.messageDelete);
      Dispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", this.loadMessagesSuccess);
      BdApi.clearCSS("SplitLargeFiles");
    }
  }
  ;
  return SplitLargeFiles;
};
