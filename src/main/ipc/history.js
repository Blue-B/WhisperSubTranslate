const path = require('path');
const fs = require('fs');
const C = require('../../shared/ipc-channels');

function historyFilePath(app) {
  return path.join(app.getPath('userData'), 'history.json');
}

function registerHistoryHandlers(ipcMain, app) {
  ipcMain.handle(C.HISTORY_LOAD, () => {
    try {
      const file = historyFilePath(app);
      if (!fs.existsSync(file)) return { success: true, list: [] };
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { success: true, list: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error.message, list: [] };
    }
  });

  ipcMain.handle(C.HISTORY_SAVE, (_event, list) => {
    try {
      const file = historyFilePath(app);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(Array.isArray(list) ? list.slice(0, 200) : []), 'utf8');
      fs.renameSync(temporary, file);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(C.SECURE_CLEAR_HISTORY, async (event) => {
    try {
      try {
        await event.sender.executeJavaScript(
          '(function(){try{localStorage.removeItem("wst_history_v1");localStorage.removeItem("wst_history");}catch(_){}' +
            'try{var pad=new Array(65536).join("0");for(var i=0;i<16;i++){localStorage.setItem("__wst_pad_"+i,pad);}for(var j=0;j<16;j++){localStorage.removeItem("__wst_pad_"+j);}}catch(_){}})();'
        );
        await event.sender.session.flushStorageData();
      } catch (_error) {}
      const file = historyFilePath(app);
      if (fs.existsSync(file)) {
        try {
          const size = fs.statSync(file).size;
          fs.writeFileSync(file, Buffer.alloc(Math.min(size, 4 * 1024 * 1024), 0));
        } catch (_error) {}
        try {
          fs.unlinkSync(file);
        } catch (error) {
          return { success: false, error: `Failed to clear history file: ${error.message}` };
        }
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerHistoryHandlers };
