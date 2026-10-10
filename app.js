/* =========================================================
   RISHI MUSIC — UPDATED APP.JS
   Continuous playback, shuffle, IndexedDB, import, backup,
   restore, GitHub sync, and playback recovery.
   ========================================================= */
'use strict';

/* -------------------- Database -------------------- */

const DB_NAME = 'rishi-music-db';
const DB_VERSION = 1;
const STORE_NAME = 'songs';

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => reject(request.error);
  });
}

function dbRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('Database is not open'));
      return;
    }

    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));

    let result;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };

      request.onerror = () => reject(request.error);
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => {
      reject(transaction.error || new Error('Transaction aborted'));
    };
  });
}

const getAllSongs = () =>
  dbRequest('readonly', store => store.getAll());

const addSong = song =>
  dbRequest('readwrite', store => store.add(song));

const putSong = song =>
  dbRequest('readwrite', store => store.put(song));

const deleteSongFromDB = id =>
  dbRequest('readwrite', store => store.delete(id));

/* -------------------- HTML elements -------------------- */

const $ = id => document.getElementById(id);

const els = {
  list: $('songList'),
  empty: $('emptyMsg'),
  title: $('listTitle'),
  count: $('countLabel'),
  search: $('searchInput'),
  select: $('directorSelect'),
  playAll: $('playAllBtn'),
  reset: $('resetBtn'),
  importBtn: $('importBtn'),
  backup: $('backupBtn'),
  sync: $('syncBtn'),
  restore: $('restoreBtn'),
  restoreInput: $('restoreInput'),
  importModal: $('importModal'),
  importDirector: $('importDirector'),
  fileInput: $('fileInput'),
  importChoose: $('importChoose'),
  importCancel: $('importCancel'),
  importStatus: $('importStatus'),
  editModal: $('editModal'),
  editTitle: $('editTitle'),
  editDirector: $('editDirector'),
  editSave: $('editSave'),
  editCancel: $('editCancel'),
  dirList: $('directorList'),
  prev: $('prevBtn'),
  play: $('playBtn'),
  next: $('nextBtn'),
  seek: $('seek'),
  cur: $('curTime'),
  dur: $('durTime'),
  nowTitle: $('nowTitle'),
  nowSub: $('nowSub'),
  toast: $('toast')
};

const UNKNOWN = 'Unknown Director';
const PLAYED_KEY = 'rishi-played-v1';
const REMOVED_KEY = 'rishi-removed-v1';
const BACKUP_MAGIC = 'RISHIMUSIC1';
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac|opus|weba)$/i;
const MARK_AFTER_SECONDS = 5;

let songs = [];
let queue = [];
let history = [];
let badIds = new Set();
let currentId = null;
let currentUrl = null;
let markedCurrent = false;
let editingId = null;
let seeking = false;
let failStreak = 0;
let stallTimer = null;
let stallRetries = 0;
let syncing = false;
let toastTimer = null;
let playRequestToken = 0;

const audio = new Audio();

audio.preload = 'auto';
audio.playsInline = true;

/* -------------------- Helpers -------------------- */

function on(element, event, handler) {
  if (element) {
    element.addEventListener(event, handler);
  }
}

function toast(message) {
  if (!els.toast) return;

  els.toast.textContent = message;
  els.toast.hidden = false;

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3500);
}

function todayKey() {
  const date = new Date();

  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function fmt(seconds) {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
    seconds = 0;
  }

  seconds = Number(seconds);

  return Math.floor(seconds / 60) + ':' +
    String(Math.floor(seconds % 60)).padStart(2, '0');
}

function cleanName(filename) {
  return String(filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';
}

function directorOf(song) {
  return String(song.director || song.artist || UNKNOWN).trim() || UNKNOWN;
}

function songTitle(song) {
  return String(song.title || song.name || 'Untitled');
}

function setRangeFill(percent) {
  if (els.seek) {
    els.seek.style.setProperty(
      '--pct',
      Math.max(0, Math.min(100, percent)) + '%'
    );
  }
}

function loadPlayed() {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PLAYED_KEY) || '{}'
    );

    const today = todayKey();

    Object.keys(stored).forEach(id => {
      if (stored[id] !== today) {
        delete stored[id];
      }
    });

    return stored;
  } catch (_) {
    return {};
  }
}

let playedMap = loadPlayed();

function savePlayed() {
  try {
    localStorage.setItem(
      PLAYED_KEY,
      JSON.stringify(playedMap)
    );
  } catch (_) {}
}

function wasPlayedToday(id) {
  return playedMap[String(id)] === todayKey();
}

function markPlayed(id) {
  if (id == null || wasPlayedToday(id)) return;

  playedMap[String(id)] = todayKey();

  savePlayed();
  renderList();
}

function artStyle(title) {
  let hash = 0;

  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  }

  const hue = 190 + (hash % 90);

  return `background:linear-gradient(135deg,hsl(${hue} 90% 62%),hsl(${hue + 28} 85% 38%))`;
}

/* -------------------- Directors -------------------- */

function getDirectors() {
  return [...new Set(songs.map(directorOf))]
    .sort((a, b) =>
      a.localeCompare(b, undefined, {
        sensitivity: 'base'
      })
    );
}

function renderDirectorSelect() {
  if (!els.select) return;

  const previous = els.select.value || '__all';

  els.select.replaceChildren(
    new Option('ALL DIRECTORS', '__all')
  );

  getDirectors().forEach(name => {
    els.select.add(new Option(name.toUpperCase(), name));
  });

  els.select.value = [...els.select.options].some(
    option => option.value === previous
  ) ? previous : '__all';

  if (els.dirList) {
    els.dirList.replaceChildren();

    getDirectors()
      .filter(name => name !== UNKNOWN)
      .forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        els.dirList.appendChild(option);
      });
  }
}

/* -------------------- Song list -------------------- */

function visibleSongs() {
  const director = els.select
    ? els.select.value
    : '__all';

  const query = els.search
    ? els.search.value.trim().toLowerCase()
    : '';

  return songs
    .filter(song =>
      director === '__all' ||
      directorOf(song) === director
    )
    .filter(song =>
      !query ||
      songTitle(song).toLowerCase().includes(query)
    )
    .sort((a, b) =>
      songTitle(a).localeCompare(
        songTitle(b),
        undefined,
        { sensitivity: 'base' }
      )
    );
}

function renderList() {
  if (!els.list) return;

  const list = visibleSongs();
  const director = els.select
    ? els.select.value
    : '__all';

  const playedCount = list.filter(
    song => wasPlayedToday(song.id)
  ).length;

  if (els.title) {
    els.title.textContent =
      director === '__all' ? 'All Songs' : director;
  }

  if (els.count) {
    els.count.textContent =
      `${list.length} ${list.length === 1 ? 'song' : 'songs'}` +
      (playedCount ? ` · ${playedCount} played today` : '');
  }

  if (els.reset) {
    els.reset.hidden = Object.keys(playedMap).length === 0;
  }

  if (els.playAll) {
    els.playAll.hidden = list.length === 0;
  }

  if (els.empty) {
    els.empty.hidden = songs.length > 0;
  }

  els.list.replaceChildren();

  list.forEach(song => {
    const played = wasPlayedToday(song.id);

    const row = document.createElement('li');

    row.className =
      'song' +
      (song.id === currentId ? ' playing' : '') +
      (played ? ' played' : '');

    const art = document.createElement('div');
    art.className = 'art';
    art.setAttribute('style', artStyle(songTitle(song)));

    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent =
      (songTitle(song).trim()[0] || '♫').toUpperCase();

    const eq = document.createElement('span');
    eq.className = 'eq';
    eq.innerHTML = '<i></i><i></i><i></i>';

    art.append(letter, eq);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = songTitle(song);

    const director = document.createElement('div');
    director.className = 'dir';
    director.textContent = directorOf(song);

    meta.append(name, director);

    if (played) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '✓ Played today';
      meta.appendChild(badge);
    }

    meta.addEventListener('click', () => {
      playFromList(song.id);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'pill-edit';
    edit.textContent = '✎ Edit';

    edit.addEventListener('click', () => {
      openEdit(song.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'round del';
    del.setAttribute('aria-label', 'Delete song');
    del.textContent = '🗑️';

    del.addEventListener('click', () => {
      removeSong(song.id);
    });

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'round go';
    play.setAttribute('aria-label', 'Play song');
    play.textContent = '▶';

    play.addEventListener('click', () => {
      playFromList(song.id);
    });

    row.append(art, meta, edit, del, play);
    els.list.appendChild(row);
  });
}

function refresh() {
  renderDirectorSelect();
  renderList();
}

/* -------------------- Continuous playback -------------------- */

function pickRandom() {
  const visibleIds = visibleSongs().map(song => song.id);

  if (!queue.length) {
    queue = visibleIds;
  }

  const validIds = new Set(songs.map(song => song.id));

  let pool = queue.filter(id =>
    validIds.has(id) &&
    id !== currentId &&
    !badIds.has(id)
  );

  let unplayed = pool.filter(
    id => !wasPlayedToday(id)
  );

  /*
   * When every eligible song has played today,
   * clear today's markers and start another cycle.
   * This prevents the player stopping just because
   * every song has already been played.
   */
  if (!unplayed.length && pool.length) {
    playedMap = {};
    savePlayed();
    renderList();
    unplayed = pool;
  }

  pool = unplayed;

  /*
   * A one-song library can replay its only song.
   */
  if (!pool.length && currentId != null) {
    const current = songs.find(
      song => song.id === currentId
    );

    if (
      current &&
      !badIds.has(currentId) &&
      queue.includes(currentId)
    ) {
      pool = [currentId];
    }
  }

  if (!pool.length) return null;

  return pool[Math.floor(Math.random() * pool.length)];
}

function playFromList(id) {
  queue = visibleSongs().map(song => song.id);
  failStreak = 0;
  badIds.delete(id);

  playSong(id, false);
}

function shufflePlay() {
  const list = visibleSongs();

  if (!list.length) {
    toast('Import songs to start listening.');
    return;
  }

  queue = list.map(song => song.id);
  failStreak = 0;

  const id = pickRandom();

  if (id == null) {
    toast('No playable songs found in this list.');
    return;
  }

  playSong(id, false);
}

async function playSong(id, fromHistory = false) {
  const song = songs.find(item => item.id === id);

  if (!song) return;

  const token = ++playRequestToken;

  clearTimeout(stallTimer);
  stallRetries = 0;

  currentId = id;
  markedCurrent = wasPlayedToday(id);

  if (
    !fromHistory &&
    history[history.length - 1] !== id
  ) {
    history.push(id);

    if (history.length > 200) {
      history.shift();
    }
  }

  audio.pause();

  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }

  if (!song.blob) {
    toast(
      'This song has no saved audio data. Try Sync or restore your backup.'
    );
    return;
  }

  currentUrl = URL.createObjectURL(song.blob);

  audio.src = currentUrl;
  audio.load();

  if (els.nowTitle) {
    els.nowTitle.textContent = songTitle(song);
  }

  if (els.nowSub) {
    els.nowSub.textContent = directorOf(song);
  }

  if (els.seek) els.seek.value = 0;
  if (els.cur) els.cur.textContent = '0:00';
  if (els.dur) els.dur.textContent = '0:00';

  setRangeFill(0);

  document.body.classList.remove('is-idle');

  updateMediaSession(song);
  renderList();

  try {
    await audio.play();

    if (token !== playRequestToken) return;

    updatePlayIcon();
  } catch (error) {
    if (token !== playRequestToken) return;

    console.warn(
      'Playback failed:',
      songTitle(song),
      error
    );

    badIds.add(id);
    failStreak++;

    if (failStreak < Math.max(queue.length, 1)) {
      toast('Could not play that file; trying the next song.');

      setTimeout(() => {
        nextTrack(true);
      }, 250);
    } else {
      toast(
        'These files could not be played. Try importing them again.'
      );
    }

    updatePlayIcon();
  }
}

function nextTrack(automatic = false) {
  const id = pickRandom();

  if (id == null) {
    updatePlayIcon();

    if (automatic) {
      toast('No playable songs remain in this list.');
    }

    return;
  }

  playSong(id, false);
}

function prevTrack() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  if (history.length < 2) {
    audio.currentTime = 0;
    return;
  }

  history.pop();

  const previousId = history[history.length - 1];

  if (
    previousId != null &&
    songs.some(song => song.id === previousId)
  ) {
    playSong(previousId, true);
  } else {
    audio.currentTime = 0;
  }
}

function togglePlay() {
  if (currentId == null) {
    shufflePlay();
    return;
  }

  if (audio.paused) {
    audio.play()
      .then(updatePlayIcon)
      .catch(error => {
        console.warn('Resume failed:', error);
        toast('Tap Play again to resume audio.');
      });
  } else {
    audio.pause();
  }
}

function updatePlayIcon() {
  if (els.play) {
    els.play.innerHTML = audio.paused
      ? '&#9654;'
      : '&#10074;&#10074;';
  }

  document.body.classList.toggle(
    'is-paused',
    audio.paused
  );

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState =
        audio.paused ? 'paused' : 'playing';
    } catch (_) {}
  }
}

/* -------------------- Audio events -------------------- */

audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', updatePlayIcon);

audio.addEventListener('playing', () => {
  failStreak = 0;
  stallRetries = 0;

  clearTimeout(stallTimer);
  updatePlayIcon();
});

audio.addEventListener('ended', () => {
  if (currentId != null) {
    markPlayed(currentId);
  }

  nextTrack(true);
});

audio.addEventListener('loadedmetadata', () => {
  if (els.dur) {
    els.dur.textContent = fmt(audio.duration);
  }

  if (els.seek) {
    els.seek.max = Number.isFinite(audio.duration)
      ? audio.duration
      : 100;
  }
});

audio.addEventListener('timeupdate', () => {
  if (
    !markedCurrent &&
    currentId != null &&
    audio.currentTime >= MARK_AFTER_SECONDS
  ) {
    markedCurrent = true;
    markPlayed(currentId);
  }

  if (seeking) return;

  if (els.cur) {
    els.cur.textContent = fmt(audio.currentTime);
  }

  if (
    els.seek &&
    Number.isFinite(audio.duration) &&
    audio.duration > 0
  ) {
    els.seek.value = audio.currentTime;

    setRangeFill(
      (audio.currentTime / audio.duration) * 100
    );
  }
});

on(els.seek, 'input', () => {
  seeking = true;

  if (els.cur) {
    els.cur.textContent = fmt(els.seek.value);
  }

  setRangeFill(
    (Number(els.seek.value) /
      (Number(els.seek.max) || 1)) * 100
  );
});

on(els.seek, 'change', () => {
  if (Number.isFinite(Number(els.seek.value))) {
    audio.currentTime = Number(els.seek.value);
  }

  seeking = false;
});

/* -------------------- Stall recovery -------------------- */

function recoverFromStall() {
  if (
    audio.paused ||
    currentId == null ||
    audio.ended ||
    stallRetries >= 2
  ) {
    return;
  }

  if (
    audio.readyState >=
    HTMLMediaElement.HAVE_FUTURE_DATA
  ) {
    return;
  }

  stallRetries++;

  const resumeAt = Number.isFinite(audio.currentTime)
    ? audio.currentTime
    : 0;

  try {
    audio.currentTime = resumeAt;
  } catch (_) {}

  audio.play().catch(error => {
    console.warn('Stall recovery deferred:', error);
  });
}

['waiting', 'stalled'].forEach(eventName => {
  audio.addEventListener(eventName, () => {
    if (audio.paused || currentId == null) return;

    clearTimeout(stallTimer);

    stallTimer = setTimeout(
      recoverFromStall,
      8000
    );
  });
});

audio.addEventListener('error', () => {
  if (currentId == null || audio.paused) return;

  const failedId = currentId;

  badIds.add(failedId);
  failStreak++;

  if (failStreak >= Math.max(queue.length, 1)) {
    toast(
      'Could not play the available audio files. Re-import the affected songs.'
    );

    updatePlayIcon();
    return;
  }

  setTimeout(() => {
    if (currentId === failedId) {
      nextTrack(true);
    }
  }, 300);
});

/* -------------------- Media Session -------------------- */

function updateMediaSession(song) {
  if (
    !('mediaSession' in navigator) ||
    typeof MediaMetadata === 'undefined'
  ) {
    return;
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: songTitle(song),
      artist: directorOf(song),
      album: 'Rishi Music',

      artwork: [
        {
          src: './icons/icon-192.png',
          sizes: '192x192',
          type: 'image/png'
        },
        {
          src: './icons/icon-512.png',
          sizes: '512x512',
          type: 'image/png'
        }
      ]
    });
  } catch (error) {
    console.warn(
      'Media Session metadata unavailable:',
      error
    );
  }
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;

  const safeAction = (name, handler) => {
    try {
      ms.setActionHandler(name, handler);
    } catch (_) {}
  };

  safeAction('play', () => {
    audio.play().catch(() => {});
  });

  safeAction('pause', () => audio.pause());

  safeAction('previoustrack', prevTrack);

  safeAction('nexttrack', () => nextTrack(false));

  safeAction('seekto', details => {
    if (details && details.seekTime != null) {
      audio.currentTime = details.seekTime;
    }
  });
}

/* -------------------- Import songs -------------------- */

function openImport() {
  if (els.importDirector) {
    els.importDirector.value = '';
  }

  if (els.importStatus) {
    els.importStatus.hidden = true;
  }

  if (els.importChoose) {
    els.importChoose.disabled = false;
  }

  if (els.importCancel) {
    els.importCancel.disabled = false;
  }

  if (els.importModal) {
    els.importModal.hidden = false;
  }
}

function closeImport() {
  if (els.importModal) {
    els.importModal.hidden = true;
  }
}

function guessType(filename) {
  const ext = (filename.split('.').pop() || '')
    .toLowerCase();

  return ({
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    weba: 'audio/webm'
  })[ext] || 'audio/mpeg';
}

async function importFiles(fileList) {
  const files = [...fileList].filter(file =>
    (file.type && file.type.startsWith('audio/')) ||
    AUDIO_RE.test(file.name)
  );

  if (!files.length) {
    toast('No audio files selected.');
    return;
  }

  const director =
    (els.importDirector?.value || '').trim() ||
    UNKNOWN;

  if (els.importChoose) {
    els.importChoose.disabled = true;
  }

  if (els.importCancel) {
    els.importCancel.disabled = true;
  }

  if (els.importStatus) {
    els.importStatus.hidden = false;
  }

  if (navigator.storage?.persist) {
    try {
      await navigator.storage.persist();
    } catch (_) {}
  }

  let saved = 0;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];

    if (els.importStatus) {
      els.importStatus.textContent =
        `Saving ${index + 1} of ${files.length}…`;
    }

    try {
      const bytes = await file.arrayBuffer();

      const blob = new Blob([bytes], {
        type: file.type || guessType(file.name)
      });

      await addSong({
        title: cleanName(file.name),
        director,
        blob,
        size: blob.size,
        added: Date.now()
      });

      saved++;
    } catch (error) {
      console.error('Import failed:', file.name, error);

      toast(
        'Storage is full or blocked. Could not save ' +
        file.name
      );

      break;
    }
  }

  songs = await getAllSongs();

  refresh();
  closeImport();

  if (els.fileInput) {
    els.fileInput.value = '';
  }

  if (els.importChoose) {
    els.importChoose.disabled = false;
  }

  if (els.importCancel) {
    els.importCancel.disabled = false;
  }

  if (saved) {
    toast(
      `${saved} ${saved === 1 ? 'song' : 'songs'} saved to your library.`
    );
  }
}

/* -------------------- Edit songs -------------------- */

function openEdit(id) {
  const song = songs.find(item => item.id === id);

  if (!song) return;

  editingId = id;

  els.editTitle.value = songTitle(song);

  els.editDirector.value =
    directorOf(song) === UNKNOWN
      ? ''
      : directorOf(song);

  els.editModal.hidden = false;
  els.editTitle.focus();
}

async function saveEdit() {
  const song = songs.find(
    item => item.id === editingId
  );

  if (!song) return;

  song.title =
    els.editTitle.value.trim() || songTitle(song);

  song.director =
    els.editDirector.value.trim() || UNKNOWN;

  await putSong(song);

  els.editModal.hidden = true;
  editingId = null;

  refresh();

  if (song.id === currentId) {
    if (els.nowTitle) {
      els.nowTitle.textContent = songTitle(song);
    }

    if (els.nowSub) {
      els.nowSub.textContent = directorOf(song);
    }

    updateMediaSession(song);
  }

  toast('Changes saved.');
}

/* -------------------- Delete songs -------------------- */

function loadRemoved() {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(REMOVED_KEY) || '[]')
    );
  } catch (_) {
    return new Set();
  }
}

function addRemoved(path) {
  const removed = loadRemoved();

  removed.add(path);

  try {
    localStorage.setItem(
      REMOVED_KEY,
      JSON.stringify([...removed])
    );
  } catch (_) {}
}

async function removeSong(id) {
  const song = songs.find(item => item.id === id);

  if (!song) return;

  if (!confirm(
    `Delete "${songTitle(song)}" from Rishi Music on this device?`
  )) {
    return;
  }

  const wasCurrent = id === currentId;

  await deleteSongFromDB(id);

  songs = songs.filter(item => item.id !== id);
  queue = queue.filter(itemId => itemId !== id);
  history = history.filter(itemId => itemId !== id);

  delete playedMap[String(id)];

  savePlayed();

  if (song.file) {
    addRemoved(song.file);
  }

  if (wasCurrent) {
    ++playRequestToken;

    audio.pause();
    audio.removeAttribute('src');
    audio.load();

    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
    }

    currentUrl = null;
    currentId = null;

    if (els.nowTitle) {
      els.nowTitle.textContent = 'No track playing';
    }

    if (els.nowSub) {
      els.nowSub.textContent =
        'Select a song from your library';
    }

    if (els.seek) els.seek.value = 0;
    if (els.cur) els.cur.textContent = '0:00';
    if (els.dur) els.dur.textContent = '0:00';

    setRangeFill(0);

    document.body.classList.add('is-idle');

    updatePlayIcon();
  }

  refresh();

  toast(
    song.file
      ? 'Song removed from this device.'
      : 'Song deleted.'
  );
}

function resetToday() {
  playedMap = {};

  savePlayed();

  badIds.clear();

  renderList();

  toast(
    'Today’s play history cleared. All songs can play again.'
  );
}

/* -------------------- GitHub repository sync -------------------- */

function repoInfo() {
  if (!location.hostname.endsWith('.github.io')) {
    return null;
  }

  const owner = location.hostname.slice(
    0,
    -'.github.io'.length
  );

  const repo = location.pathname
    .split('/')
    .filter(Boolean)[0];

  return owner && repo
    ? { owner, repo }
    : null;
}

async function listRepoSongs() {
  const info = repoInfo();

  if (!info) return null;

  for (const branch of ['main', 'master']) {
    try {
      const endpoint =
        `https://api.github.com/repos/${info.owner}/${info.repo}/git/trees/${branch}?recursive=1`;

      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      });

      if (response.status === 404) {
        continue;
      }

      if (!response.ok) return null;

      const data = await response.json();

      return (data.tree || [])
        .filter(item =>
          item.type === 'blob' &&
          item.path.startsWith('songs/') &&
          AUDIO_RE.test(item.path)
        )
        .map(item => item.path);

    } catch (error) {
      console.warn(
        'Could not list repository songs:',
        error
      );

      return null;
    }
  }

  return null;
}

async function syncRepoSongs(manual = false) {
  if (syncing) return;

  syncing = true;

  try {
    const paths = await listRepoSongs();

    if (paths === null) {
      if (manual) {
        toast(
          'Could not reach GitHub. Check your internet and try again.'
        );
      }

      return;
    }

    const existing = new Set(
      songs
        .filter(song => song.file)
        .map(song => song.file)
    );

    const removed = loadRemoved();

    const todo = paths.filter(path =>
      !existing.has(path) &&
      !removed.has(path)
    );

    if (!todo.length) {
      if (manual) {
        toast(
          paths.length
            ? 'Your library is up to date.'
            : 'No audio files found in the repository songs/ folder.'
        );
      }

      return;
    }

    if (navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch (_) {}
    }

    let added = 0;
    let failed = 0;

    for (let index = 0; index < todo.length; index++) {
      const path = todo[index];

      toast(
        `Syncing song ${index + 1} of ${todo.length}…`
      );

      try {
        const url = path
          .split('/')
          .map(encodeURIComponent)
          .join('/');

        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        let blob = await response.blob();

        const parts = path.split('/');
        const filename = parts[parts.length - 1];

        if (!blob.type.startsWith('audio/')) {
          blob = new Blob([blob], {
            type: guessType(filename)
          });
        }

        await addSong({
          title: cleanName(filename),
          director: parts.length > 2
            ? parts[1]
            : UNKNOWN,
          blob,
          size: blob.size,
          added: Date.now(),
          file: path
        });

        added++;

      } catch (error) {
        console.error('Sync failed:', path, error);
        failed++;
      }
    }

    songs = await getAllSongs();

    refresh();

    toast(
      `${added} ${added === 1 ? 'song' : 'songs'} added from GitHub` +
      (failed ? `; ${failed} failed` : '') +
      '.'
    );

  } finally {
    syncing = false;
  }
}

/* -------------------- Backup -------------------- */

async function exportBackup() {
  if (!songs.length) {
    toast('Nothing to back up yet.');
    return;
  }

  try {
    const metadata = songs.map(song => ({
      title: songTitle(song),
      director: directorOf(song),
      type: song.blob.type || 'audio/mpeg',
      size: song.blob.size,
      added: song.added || Date.now(),
      file: song.file || null
    }));

    const header = new TextEncoder().encode(
      JSON.stringify({
        magic: BACKUP_MAGIC,
        songs: metadata
      })
    );

    const length = new Uint8Array(4);

    new DataView(length.buffer).setUint32(
      0,
      header.length
    );

    const backupBlob = new Blob([
      length,
      header,
      ...songs.map(song => song.blob)
    ], {
      type: 'application/octet-stream'
    });

    const url = URL.createObjectURL(backupBlob);

    const link = document.createElement('a');

    link.href = url;
    link.download =
      `rishi-music-backup-${todayKey()}.rmbackup`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);

    toast('Backup download started.');

  } catch (error) {
    console.error('Backup failed:', error);
    toast('Could not create the backup.');
  }
}

/* -------------------- Restore backup -------------------- */

async function restoreBackup(file) {
  try {
    if (file.size < 5) {
      throw new Error('File is too small');
    }

    const firstFour = await file.slice(0, 4).arrayBuffer();

    const headerLength = new DataView(
      firstFour
    ).getUint32(0);

    if (
      headerLength <= 0 ||
      headerLength > file.size - 4
    ) {
      throw new Error('Invalid header length');
    }

    const header = JSON.parse(
      await file.slice(4, 4 + headerLength).text()
    );

    if (
      header.magic !== BACKUP_MAGIC ||
      !Array.isArray(header.songs)
    ) {
      throw new Error('Invalid backup');
    }

    const known = new Set(
      songs.map(song =>
        `${songTitle(song)}|${directorOf(song)}|${song.blob.size}`
      )
    );

    let offset = 4 + headerLength;
    let added = 0;
    let skipped = 0;

    for (
      let index = 0;
      index < header.songs.length;
      index++
    ) {
      const meta = header.songs[index];

      if (
        !Number.isFinite(meta.size) ||
        meta.size < 0 ||
        offset + meta.size > file.size
      ) {
        throw new Error('Invalid song data');
      }

      toast(
        `Restoring ${index + 1} of ${header.songs.length}…`
      );

      const part = file.slice(
        offset,
        offset + meta.size
      );

      offset += meta.size;

      const key =
        `${meta.title}|${meta.director}|${meta.size}`;

      if (known.has(key)) {
        skipped++;
        continue;
      }

      await addSong({
        title: meta.title || 'Untitled',
        director: meta.director || UNKNOWN,
        blob: new Blob([
          await part.arrayBuffer()
        ], {
          type: meta.type || 'audio/mpeg'
        }),
        size: meta.size,
        added: meta.added || Date.now(),
        file: meta.file || undefined
      });

      known.add(key);
      added++;
    }

    songs = await getAllSongs();

    refresh();

    toast(
      `${added} restored` +
      (skipped ? `; ${skipped} already existed` : '') +
      '.'
    );

  } catch (error) {
    console.error('Restore failed:', error);

    toast(
      'That is not a valid Rishi Music backup.'
    );
  }
}

/* -------------------- Button events -------------------- */

on(els.importBtn, 'click', openImport);

on(els.backup, 'click', exportBackup);

on(els.sync, 'click', () => {
  syncRepoSongs(true);
});

on(els.restore, 'click', () => {
  els.restoreInput?.click();
});

on(els.restoreInput, 'change', () => {
  const file =
    els.restoreInput.files &&
    els.restoreInput.files[0];

  if (file) {
    restoreBackup(file);
  }

  els.restoreInput.value = '';
});

on(els.importCancel, 'click', closeImport);

on(els.importChoose, 'click', () => {
  els.fileInput?.click();
});

on(els.fileInput, 'change', () => {
  if (els.fileInput.files?.length) {
    importFiles(els.fileInput.files);
  }
});

on(els.editCancel, 'click', () => {
  if (els.editModal) {
    els.editModal.hidden = true;
  }
});

on(els.editSave, 'click', saveEdit);

[els.importModal, els.editModal]
  .filter(Boolean)
  .forEach(modal => {
    modal.addEventListener('click', event => {
      if (event.target === modal) {
        closeImportOrEdit(modal);
      }
    });
  });

function closeImportOrEdit(modal) {
  if (modal === els.importModal) {
    closeImport();
  } else {
    modal.hidden = true;
  }
}

on(els.select, 'change', renderList);
on(els.search, 'input', renderList);
on(els.playAll, 'click', shufflePlay);
on(els.reset, 'click', resetToday);
on(els.play, 'click', togglePlay);
on(els.next, 'click', () => nextTrack(false));
on(els.prev, 'click', prevTrack);

/* -------------------- Visibility changes -------------------- */

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    playedMap = loadPlayed();
    renderList();
  }
});

/* -------------------- Start application -------------------- */

(async function init() {
  try {
    db = await openDB();

    songs = await getAllSongs();

    refresh();

    // GitHub sync is optional.
    // Imported IndexedDB songs remain available offline.
    syncRepoSongs(false);

  } catch (error) {
    console.error(
      'Rishi Music startup failed:',
      error
    );

    toast(
      'Storage is not available in this browser.'
    );
  }
})();

/* -------------------- Service worker -------------------- */
/* Keep registration here only.
   Do not duplicate it in index.html. */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(error => {
        console.warn(
          'Service worker registration failed:',
          error
        );
      });
  });
}