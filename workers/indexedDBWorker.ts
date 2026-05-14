import JSZip from 'jszip';

// Global variables
let canvasCount = 0;
let selectedChannels: number[] = [];

self.onmessage = async (event) => {
  const { action, data, filename, selectedChannels: channels, meta } = event.data;

  // Open IndexedDB
  const db = await openIndexedDB();

  const handlePostMessage = (message: any) => {
    self.postMessage(message);
  };

  const handleError = (error: string) => {
    handlePostMessage({ error });
  };

  switch (action) {
    case 'setCanvasCount':
      canvasCount = event.data.canvasCount;
      handlePostMessage({ success: true, message: 'Canvas count updated' });
      break;

    case 'setSelectedChannels':
      if (Array.isArray(channels) && channels.every((ch) => typeof ch === 'number')) {
        selectedChannels = channels;
        handlePostMessage({ success: true, message: 'Selected channels updated' });
      } else {
        console.error('Invalid selectedChannels received:', channels);
        handlePostMessage({ success: false, message: 'Invalid selectedChannels format' });
      }
      break;

    case 'write':
      try {
        const success = await writeToIndexedDB(db, data, filename);
        handlePostMessage({ success });
      } catch (error) {
        handleError('Failed to write data to IndexedDB');
      }
      break;

    case 'writeMeta':
      try {
        await writeMetaToIndexedDB(db, filename, meta);
        handlePostMessage({ success: true, action: 'writeMeta' });
      } catch (error) {
        handleError('Failed to write meta to IndexedDB');
      }
      break;

    case 'loadByFilename':
      try {
        const record = await loadRecordByFilename(db, filename);
        handlePostMessage({
          action: 'loadByFilename',
          rows: record?.content ?? [],
          meta: record?.meta ?? null,
        });
      } catch (error) {
        handleError('Failed to load recording from IndexedDB');
      }
      break;

    case 'getFileCountFromIndexedDB':
      try {
        const dataMethod = action === 'getAllData' ? getAllDataFromIndexedDB : getFileCountFromIndexedDB;
        const allData = await dataMethod(db);
        handlePostMessage({ allData });
      } catch (error) {
        handleError('Failed to retrieve data from IndexedDB');
      }
      break;

    case 'saveAsZip':
      try {
        const zipBlob = await saveAllDataAsZip(canvasCount, selectedChannels);
        handlePostMessage({ zipBlob });
      } catch (error) {
        handleError('Failed to create ZIP file');
      }
      break;

    case 'saveDataByFilename':
      try {
        const blob = await saveDataByFilename(filename, canvasCount, selectedChannels);
        handlePostMessage({ blob });
      } catch (error) {
        handleError(error instanceof Error ? error.message : 'Unknown error');
      }

      break;

    case 'deleteFile':
      if (!filename) {
        throw new Error('Filename is required for deleteFile action.');
      }
      await deleteFilesByFilename(filename);
      handlePostMessage({ success: true, action: 'deleteFile' });
      break;

    case 'deleteAll':
      await deleteAllDataFromIndexedDB();
      handlePostMessage({ success: true, action: 'deleteAll' });
      break;



    default:
      handlePostMessage({ error: 'Invalid action' });
  }
};

// Function to open IndexedDB
const openIndexedDB = async (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ChordsRecordings", 2);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const store = db.createObjectStore("ChordsRecordings", { keyPath: "filename" });
      store.createIndex("filename", "filename", { unique: true });
    };

    request.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
    request.onerror = (event) => reject((event.target as IDBOpenDBRequest).error);
  });
};

// Helper function for IndexedDB transactions
const performIndexDBTransaction = async <T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => Promise<T>
): Promise<T> => {
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);

  try {
    return await callback(store); // Await the callback directly
  } catch (error) {
    throw new Error(`Transaction failed: ${error}`);
  }
};

// Function to write data to IndexedDB
const writeToIndexedDB = async (
  db: IDBDatabase,
  data: number[][],
  filename: string
): Promise<boolean> => {
  try {
    const existingRecord = await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", (store) => {
      return new Promise<any>((resolve, reject) => {
        const getRequest = store.get(filename);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(new Error("Error retrieving record"));
      });
    });

    if (existingRecord) {
      existingRecord.content.push(...data);
      await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", (store) => {
        return new Promise<void>((resolve, reject) => {
          const putRequest = store.put(existingRecord);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(new Error("Error updating record"));
        });
      });
    } else {
      const newRecord = { filename, content: [...data] };
      await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", (store) => {
        return new Promise<void>((resolve, reject) => {
          const putRequest = store.put(newRecord);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(new Error("Error inserting record"));
        });
      });
    }

    return true;
  } catch (error) {
    console.error("Error writing to IndexedDB:", error);
    return false;
  }
};


// Function to get all data from IndexedDB
const getAllDataFromIndexedDB = async (db: IDBDatabase): Promise<any[]> => {
  try {
    return await performIndexDBTransaction(db, "ChordsRecordings", "readonly", (store) => {
      return new Promise<any[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (error) => reject(new Error(`Error retrieving data: ${error}`));
      });
    });
  } catch (error) {
    console.error("Error retrieving data from IndexedDB:", error);
    throw error;
  }
};

// Write or merge metadata onto an existing recording record.
const writeMetaToIndexedDB = async (db: IDBDatabase, filename: string, meta: any): Promise<void> => {
  const existing = await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", (store) => {
    return new Promise<any>((resolve, reject) => {
      const req = store.get(filename);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("Error retrieving record for meta write"));
    });
  });
  const next = existing
    ? { ...existing, meta }
    : { filename, content: [] as number[][], meta };
  await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", (store) => {
    return new Promise<void>((resolve, reject) => {
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(new Error("Error writing meta"));
    });
  });
};

const loadRecordByFilename = async (db: IDBDatabase, filename: string): Promise<{ filename: string; content: number[][]; meta?: any } | null> => {
  return performIndexDBTransaction(db, "ChordsRecordings", "readonly", (store) => {
    return new Promise((resolve, reject) => {
      const req = store.index("filename").get(filename);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(new Error("Error retrieving record by filename"));
    });
  });
};

// Function to convert data to CSV
// Two row formats supported:
//   Legacy (pre-dual-stream-replay):  [counter, ch1, ch2, ch3]
//   Replay-ready:                     [slot, tWallMs, tStreamMs, counter, raw0, raw1, raw2, filtered0, filtered1, filtered2]
// We detect by length and emit the appropriate header. Replay-ready files also get a meta
// comment line at the very top so the loader can restore sampling rate / filter config.
const convertToCSV = (data: any[], canvasCount: number, selectedChannels: number[], meta?: any): string => {
  if (!Array.isArray(data) || data.length === 0) return "";

  const firstRow = data.find((r) => Array.isArray(r) && r.length > 0);
  const isReplayReady = Array.isArray(firstRow) && firstRow.length >= 10;

  let header: string[];
  if (isReplayReady) {
    header = [
      "Slot", "tWallMs", "tStreamMs", "Counter",
      "Raw0", "Raw1", "Raw2",
      "Filtered0", "Filtered1", "Filtered2",
    ];
  } else {
    header = ["Counter", ...selectedChannels.map((channel) => `Channel${channel}`)];
  }

  const rows = data
    .filter((item, index) => {
      if (!item || !Array.isArray(item) || item.length === 0) {
        console.warn(`Skipping invalid data at index ${index}:`, item);
        return false;
      }
      return true;
    })
    .map((item, index) => {
      let filteredRow: any[];
      if (isReplayReady) {
        filteredRow = item;
      } else {
        filteredRow = [
          item[0],
          ...selectedChannels.map((channel, i) => {
            if (channel) return item[i + 1];
            console.warn(`Missing data for channel ${channel} in item ${index}:`, item);
            return "";
          }),
        ];
      }
      return filteredRow
        .map((field) => (field !== undefined && field !== null ? JSON.stringify(field) : ""))
        .join(",");
    });

  const lines: string[] = [];
  if (isReplayReady && meta) {
    lines.push(`# meta: ${JSON.stringify(meta)}`);
  }
  lines.push(header.join(","));
  lines.push(...rows);
  return lines.join("\n");
};

// Function to save all data as a ZIP file
const saveAllDataAsZip = async (canvasCount: number, selectedChannels: number[]): Promise<Blob> => {
  try {
    const db = await openIndexedDB();

    const allData = await performIndexDBTransaction(db, "ChordsRecordings", "readonly", (store) => {
      return new Promise<any[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });

    if (!allData || allData.length === 0) {
      throw new Error("No data available to download.");
    }

    const zip = new JSZip();

    allData.forEach((record) => {
      try {
        const csvData = convertToCSV(record.content, canvasCount, selectedChannels, record.meta);
        zip.file(record.filename, csvData);
      } catch (error) {
        console.error(`Error processing record ${record.filename}:`, error);
      }
    });

    // Worker must not access UI. Return the blob to the main thread instead.

    const content = await zip.generateAsync({ type: "blob" });
    return content;
  } catch (error) {
    console.error("Error creating ZIP file:", error);
    throw error;
  }
};

// Function to save data by filename
const saveDataByFilename = async (
  filename: string,
  canvasCount: number,
  selectedChannels: number[]
): Promise<Blob> => {
  try {
    const db = await openIndexedDB();

    const record = await performIndexDBTransaction(db, "ChordsRecordings", "readonly", (store) => {
      return new Promise<any>((resolve, reject) => {
        const index = store.index("filename");
        const getRequest = index.get(filename);

        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(new Error("Error retrieving record"));
      });
    });

    if (!record || !Array.isArray(record.content)) {
      throw new Error("No data found for the given filename or invalid data format.");
    }

    // Validate the content structure
    if (!record.content.every((item: any) => Array.isArray(item))) {
      throw new Error("Content data contains invalid or non-array elements.");
    }

    try {
      const csvData = convertToCSV(record.content, canvasCount, selectedChannels, record.meta);
      const blob = new Blob([csvData], { type: "text/csv;charset=utf-8" });
      return blob;
    } catch (conversionError) {
      console.error("Error converting data to CSV:", conversionError);
      throw new Error("Failed to convert data to CSV format.");
    }
  } catch (error) {
    console.error("Error during file download:", error);
    throw new Error("Error occurred during file download.");
  }
};

// Function to get file count from IndexedDB
const getFileCountFromIndexedDB = async (db: IDBDatabase): Promise<string[]> => {
  return performIndexDBTransaction(db, "ChordsRecordings", "readonly", (store) => {
    return new Promise<string[]>((resolve, reject) => {
      const filenames: string[] = [];
      const cursorRequest = store.openCursor();

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result as IDBCursorWithValue | null;
        if (cursor) {
          filenames.push(cursor.value.filename);
          cursor.continue();
        } else {
          resolve(filenames);
        }
      };

      cursorRequest.onerror = (event) => {
        const error = (event.target as IDBRequest).error;
        console.error("Error retrieving filenames from IndexedDB:", error);
        reject(error);
      };
    });
  });
};

const deleteFilesByFilename = async (filename: string) => {
  const dbRequest = indexedDB.open("ChordsRecordings");

  return new Promise<void>((resolve, reject) => {
    dbRequest.onsuccess = async (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      try {
        await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", async (store) => {
          if (!store.indexNames.contains("filename")) {
            throw new Error("Index 'filename' does not exist.");
          }

          const index = store.index("filename");
          const cursorRequest = index.openCursor(IDBKeyRange.only(filename));

          return new Promise<void>((resolveCursor, rejectCursor) => {
            cursorRequest.onsuccess = (cursorEvent) => {
              const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue>).result;
              if (cursor) {
                cursor.delete();
                resolveCursor();
              } else {
                resolveCursor(); // No file found, still resolve
              }
            };

            cursorRequest.onerror = () => rejectCursor(new Error("Error during cursor operation."));
          });
        });

        resolve();
      } catch (error) {
        reject(error);
      }
    };

    dbRequest.onerror = () => reject(new Error("Failed to open IndexedDB database."));
  });
};

const deleteAllDataFromIndexedDB = async () => {
  const dbRequest = indexedDB.open("ChordsRecordings", 2);

  return new Promise<void>((resolve, reject) => {
    dbRequest.onsuccess = async (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      try {
        await performIndexDBTransaction(db, "ChordsRecordings", "readwrite", async (store) => {
          const clearRequest = store.clear();

          return new Promise<void>((resolveClear, rejectClear) => {
            clearRequest.onsuccess = () => resolveClear();
            clearRequest.onerror = () => rejectClear(new Error("Failed to clear IndexedDB store."));
          });
        });

        resolve();
      } catch (error) {
        reject(error);
      }
    };

    dbRequest.onerror = () => reject(new Error("Failed to open IndexedDB."));
    dbRequest.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains("ChordsRecordings")) {
        const store = db.createObjectStore("ChordsRecordings", { keyPath: "filename" });
        store.createIndex("filename", "filename", { unique: false });
      }
    };
  });
};

