function deleteNote(noteId) {
  fetch("/delete-note", {
    method: "POST",
    body: JSON.stringify({ noteId: noteId }),
  }).then((_res) => {
    window.location.href = "/";
  });
}

function updateStatus(noteId, status) {
  fetch("/update-status", {
    method: "POST",
    body: JSON.stringify({ noteId, status }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data || !data.ok) return;

      // If task is canceled, automatically pause its pomodoro timer
      if (status === "canceled") {
        pausePomodoro(noteId);
      }

      // Keep existing behavior for all statuses: refresh page to reflect changes
      window.location.href = "/";
    });
}

// ===== Pomodoro Progress Bar Manager =====

class PomodoroProgressBar {
  constructor(taskId, duration = 25 * 60) {
    this.taskId = taskId;
    this.duration = duration;
    this.remaining = duration;
    this.interval = null;
    this.isPaused = false;
    this.isCompleted = false;
    
    // DOM elements
    this.container = document.querySelector(`.pomodoro-progress-container[data-task-id="${taskId}"]`);
    if (!this.container) return;
    
    this.progressFill = this.container.querySelector('.pomodoro-progress-fill');
    this.timerDisplay = this.container.querySelector('.pomodoro-timer');
    this.label = this.container.querySelector('.pomodoro-label');
    
    // Buttons
    this.startBtn = document.querySelector(`button[data-note-id-start="${taskId}"]`);
    this.pauseBtn = document.querySelector(`button[data-note-id-pause="${taskId}"]`);
    this.completeBtn = document.querySelector(`button[data-note-id-complete="${taskId}"]`);
  }
  
  start() {
    if (this.interval) return;
    
    this.isCompleted = false;
    this.isPaused = false;
    this.progressFill.classList.add('active');
    this.progressFill.classList.remove('completed');
    this.timerDisplay.classList.add('active');
    this.timerDisplay.classList.remove('completed', 'paused');
    
    if (this.startBtn) this.startBtn.classList.add('d-none');
    if (this.pauseBtn) this.pauseBtn.classList.remove('d-none');
    if (this.completeBtn) this.completeBtn.classList.remove('d-none');
    
    // Optional absolute finish from UI or default from note
    let targetEndAt = null;
    const finishInput = document.querySelector(`input[data-finish-at=\"${this.taskId}\"]`);
    if (finishInput && finishInput.value) {
      const dt = new Date(finishInput.value);
      if (!isNaN(dt.getTime())) {
        targetEndAt = dt.toISOString();
      }
    }
    if (!targetEndAt && this.container) {
      const def = this.container.getAttribute('data-default-finish-at');
      if (def) {
        targetEndAt = def;
      }
    }
    // If we have an absolute finish, align duration/remaining to it
    if (targetEndAt) {
      const tms = Date.parse(targetEndAt);
      if (!isNaN(tms)) {
        const rem = Math.max(1, Math.floor((tms - Date.now()) / 1000));
        this.duration = rem;
        this.remaining = rem;
      }
    }

    // Start ticking after duration is aligned
    this.interval = setInterval(() => this.tick(), 1000);
    this.updateUI();

    // Notify server
    const payload = { noteId: this.taskId };
    if (targetEndAt) {
      payload.targetEndAt = targetEndAt;
    } else {
      payload.durationSeconds = this.duration;
    }
    fetch("/pomodoro/start", {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((res) => res.json()).then((data) => {
      if (data.ok && data.sessionId) {
        const key = `pomodoro:${this.taskId}`;
        localStorage.setItem(key, JSON.stringify({ 
          sessionId: data.sessionId, 
          targetAt: data.targetAt,
          duration: this.duration,
          remaining: this.remaining
        }));
      }
    }).catch(() => {
      // If server fails, still save to localStorage
      this.saveState();
    });
  }
  
  pause() {
    if (!this.interval) return;
    
    clearInterval(this.interval);
    this.interval = null;
    this.isPaused = true;
    this.progressFill.classList.remove('active');
    this.timerDisplay.classList.add('paused');
    
    if (this.pauseBtn) this.pauseBtn.classList.add('d-none');
    if (this.startBtn) {
      this.startBtn.classList.remove('d-none');
      this.startBtn.innerHTML = '<i class="bi bi-play-circle"></i><span>Resume</span>';
    }
    
    // Save paused state locally
    this.saveState();
    // Notify server pause with remaining
    const key = `pomodoro:${this.taskId}`;
    const stored = localStorage.getItem(key);
    let sessionId = null;
    if (stored) {
      try { sessionId = JSON.parse(stored).sessionId; } catch (_) {}
    }
    if (sessionId) {
      fetch("/pomodoro/pause", {
        method: "POST",
        body: JSON.stringify({ sessionId, remainingSeconds: this.remaining })
      }).catch(() => {});
    }
  }
  
  resume() {
    if (this.interval || !this.isPaused) return;
    
    this.isPaused = false;
    this.progressFill.classList.add('active');
    this.timerDisplay.classList.remove('paused');
    
    if (this.startBtn) this.startBtn.classList.add('d-none');
    if (this.pauseBtn) this.pauseBtn.classList.remove('d-none');
    
    // Notify server to resume and get new targetAt
    const key = `pomodoro:${this.taskId}`;
    const stored = localStorage.getItem(key);
    let sessionId = null;
    if (stored) {
      try { sessionId = JSON.parse(stored).sessionId; } catch (_) {}
    }
    if (sessionId) {
      fetch("/pomodoro/resume", {
        method: "POST",
        body: JSON.stringify({ sessionId })
      }).then((r) => r.json()).then((data) => {
        if (data && data.ok && data.targetAt) {
          const cur = JSON.parse(localStorage.getItem(key) || '{}');
          cur.targetAt = data.targetAt;
          localStorage.setItem(key, JSON.stringify(cur));
        }
      }).catch(() => {});
    }
    this.interval = setInterval(() => this.tick(), 1000);
  }
  
  complete() {
    this.stop();
    this.isCompleted = true;
    this.remaining = 0;
    
    this.progressFill.style.width = '100%';
    this.progressFill.classList.remove('active');
    this.progressFill.classList.add('completed');
    this.timerDisplay.textContent = 'Done!';
    this.timerDisplay.classList.remove('active', 'paused');
    this.timerDisplay.classList.add('completed');
    this.label.textContent = 'Completed';
    
    if (this.pauseBtn) this.pauseBtn.classList.add('d-none');
    if (this.completeBtn) this.completeBtn.classList.add('d-none');
    if (this.startBtn) {
      this.startBtn.classList.remove('d-none');
      this.startBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i><span>Reset</span>';
      this.startBtn.onclick = () => this.reset();
    }
    
    // Notify server
    const key = `pomodoro:${this.taskId}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      const { sessionId } = JSON.parse(stored);
      fetch("/pomodoro/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      }).then((r) => r.json()).then((data) => {
        if (data.ok) {
          localStorage.removeItem(key);
          setTimeout(() => window.location.reload(), 1500);
        }
      });
    }
  }
  
  reset() {
    this.stop();
    this.remaining = this.duration;
    this.isCompleted = false;
    this.isPaused = false;
    
    this.progressFill.style.width = '0%';
    this.progressFill.classList.remove('active', 'completed');
    this.timerDisplay.textContent = this.formatTime(this.duration);
    this.timerDisplay.classList.remove('active', 'completed', 'paused');
    this.label.textContent = 'Focus Session';
    
    if (this.startBtn) {
      this.startBtn.classList.remove('d-none');
      this.startBtn.innerHTML = '<i class="bi bi-play-circle"></i><span>Start</span>';
      this.startBtn.onclick = () => startPomodoro(this.taskId, this.duration / 60);
    }
    if (this.pauseBtn) this.pauseBtn.classList.add('d-none');
    if (this.completeBtn) this.completeBtn.classList.add('d-none');
    
    // Clear localStorage
    const key = `pomodoro:${this.taskId}`;
    localStorage.removeItem(key);
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
  
  tick() {
    if (this.remaining <= 0) {
      this.complete();
      return;
    }
    
    this.remaining--;
    this.updateUI();
    
    // Save state every 5 seconds to localStorage
    if (this.remaining % 5 === 0) {
      this.saveState();
    }
  }
  
  saveState() {
    const key = `pomodoro:${this.taskId}`;
    const now = Date.now();
    const targetAt = new Date(now + (this.remaining * 1000)).toISOString();
    
    const stored = localStorage.getItem(key);
    let sessionId = null;
    if (stored) {
      const data = JSON.parse(stored);
      sessionId = data.sessionId;
    }
    
    localStorage.setItem(key, JSON.stringify({
      sessionId: sessionId,
      targetAt: targetAt,
      duration: this.duration,
      remaining: this.remaining
    }));
  }
  
  updateUI() {
    const progress = ((this.duration - this.remaining) / this.duration) * 100;
    this.progressFill.style.width = `${Math.min(progress, 100)}%`;
    this.timerDisplay.textContent = this.formatTime(this.remaining);
  }
  
  formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const days = Math.floor(s / 86400);
    const rem1 = s % 86400;
    const hrs = Math.floor(rem1 / 3600);
    const rem2 = rem1 % 3600;
    const mins = Math.floor(rem2 / 60);
    const secs = rem2 % 60;
    if (days > 0) {
      return `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}

// Global instances
const pomodoroInstances = new Map();

function getTaskKey(taskId) {
  // Normalize keys to string so restored sessions (from localStorage) and
  // inline handlers (which may pass numbers) always refer to the same entry.
  return String(taskId);
}

function startPomodoro(taskId, durationMinutes = 25) {
  const key = getTaskKey(taskId);
  let instance = pomodoroInstances.get(key);
  
  if (!instance) {
    instance = new PomodoroProgressBar(taskId, durationMinutes * 60);
    pomodoroInstances.set(key, instance);
  }
  
  if (instance.isPaused) {
    instance.resume();
  } else {
    instance.start();
  }
}

function pausePomodoro(taskId) {
  const instance = pomodoroInstances.get(getTaskKey(taskId));
  if (instance) instance.pause();
}

function completePomodoro(taskId) {
  const instance = pomodoroInstances.get(getTaskKey(taskId));
  if (instance) instance.complete();
}

function resetPomodoro(taskId) {
  const instance = pomodoroInstances.get(getTaskKey(taskId));
  if (instance) instance.reset();
}

// Expose functions globally for inline handlers in templates
window.startPomodoro = startPomodoro;
window.pausePomodoro = pausePomodoro;
window.completePomodoro = completePomodoro;
window.resetPomodoro = resetPomodoro;
window.openEditModal = openEditModal;
window.submitEditModal = submitEditModal;
window.updateStatus = updateStatus;
window.deleteNote = deleteNote;

// Auto-initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  // Toggle minutes vs finish_by in add form (finish_by takes precedence)
  const minEl = document.getElementById('pomodoro_minutes');
  const finishEl = document.getElementById('finish_by');
  if (minEl && finishEl) {
    const sync = () => {
      if (finishEl.value) {
        minEl.classList.add('is-disabled');
        minEl.setAttribute('disabled', 'disabled');
      } else {
        minEl.classList.remove('is-disabled');
        minEl.removeAttribute('disabled');
      }
    };
    finishEl.addEventListener('input', sync);
    sync();
  }
  // First, ask server for active sessions to ensure cross-device persistence
  fetch('/pomodoro/active', { method: 'GET' })
    .then((r) => r.json())
    .then((resp) => {
      if (resp && resp.ok && Array.isArray(resp.sessions)) {
        resp.sessions.forEach((s) => {
          const key = `pomodoro:${s.noteId}`;
          const existing = JSON.parse(localStorage.getItem(key) || '{}');
          // Prefer server targetAt
          localStorage.setItem(key, JSON.stringify({
            sessionId: s.sessionId,
            targetAt: s.targetAt,
            duration: existing.duration || s.remainingSeconds, // fallback
            remaining: s.remainingSeconds,
            isPaused: !!s.isPaused
          }));
        });
      }
    })
    .finally(() => {
      // Restore any active pomodoros from localStorage
      Object.keys(localStorage).filter((k) => k.startsWith('pomodoro:')).forEach((key) => {
        const taskId = key.split(':')[1];
        const data = JSON.parse(localStorage.getItem(key) || '{}');
        const container = document.querySelector(`.pomodoro-progress-container[data-task-id=\"${taskId}\"]`);
        if (!container) return;
        
        // Determine default duration from DOM label if missing
        let defaultDuration = 25 * 60;
        const timerEl = container.querySelector('.pomodoro-timer');
        if (timerEl && /\d{2}:\d{2}/.test(timerEl.textContent)) {
          const [mm, ss] = timerEl.textContent.split(':').map((x) => parseInt(x, 10));
          if (!isNaN(mm)) defaultDuration = mm * 60 + (isNaN(ss) ? 0 : ss);
        }
        const duration = data.duration || defaultDuration;
        
        let remaining;
        // Calculate remaining time from targetAt or use stored remaining
        if (data.targetAt) {
          const targetAt = Date.parse(data.targetAt);
          const now = Date.now();
          remaining = Math.max(0, Math.floor((targetAt - now) / 1000));
        } else if (data.remaining !== undefined) {
          remaining = data.remaining;
        } else {
          remaining = 0;
        }
        
        if (remaining > 0) {
          // Create instance and restore state
          const instance = new PomodoroProgressBar(taskId, duration);
          instance.remaining = remaining;
          pomodoroInstances.set(taskId, instance);
          
          const isPaused = !!data.isPaused;
          if (isPaused) {
            // Restore paused UI
            instance.isPaused = true;
            instance.progressFill.classList.remove('active');
            instance.timerDisplay.classList.remove('active');
            instance.timerDisplay.classList.add('paused');
            if (instance.pauseBtn) instance.pauseBtn.classList.add('d-none');
            if (instance.startBtn) {
              instance.startBtn.classList.remove('d-none');
              instance.startBtn.innerHTML = '<i class=\"bi bi-play-circle\"></i><span>Resume</span>';
            }
            if (instance.completeBtn) instance.completeBtn.classList.remove('d-none');
            instance.updateUI();
          } else {
            // Restore active running UI
            instance.progressFill.classList.add('active');
            instance.timerDisplay.classList.add('active');
            instance.timerDisplay.classList.remove('paused');
            instance.updateUI();
            if (instance.startBtn) instance.startBtn.classList.add('d-none');
            if (instance.pauseBtn) instance.pauseBtn.classList.remove('d-none');
            if (instance.completeBtn) instance.completeBtn.classList.remove('d-none');
            // Start the interval
            instance.interval = setInterval(() => instance.tick(), 1000);
          }
        } else {
          // Timer expired, clear it
          localStorage.removeItem(key);
        }
      });

      // Also set initial display in days for tasks with a saved finish_by when idle
      document.querySelectorAll('.pomodoro-progress-container[data-default-finish-at]').forEach((container) => {
        const taskId = container.getAttribute('data-task-id');
        const key = `pomodoro:${taskId}`;
        if (localStorage.getItem(key)) return; // already handled by restore
        const def = container.getAttribute('data-default-finish-at');
        const tms = Date.parse(def);
        if (isNaN(tms)) return;
        const now = Date.now();
        const remaining = Math.max(0, Math.floor((tms - now) / 1000));
        const timerEl = container.querySelector('.pomodoro-timer');
        if (!timerEl) return;
        // Reuse formatting without instantiating a full timer
        const fmt = ((sec) => {
          const s = Math.max(0, Math.floor(sec));
          const days = Math.floor(s / 86400);
          const rem1 = s % 86400;
          const hrs = Math.floor(rem1 / 3600);
          const rem2 = rem1 % 3600;
          const mins = Math.floor(rem2 / 60);
          const secs = rem2 % 60;
          if (days > 0) return `${days}d ${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
          if (hrs > 0) return `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
          return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
        });
        timerEl.textContent = fmt(remaining);
      });
    });
});

function openEditModal(noteId, currentText, currentMinutes) {
  const idEl = document.getElementById('edit_note_id');
  const textEl = document.getElementById('edit_note_text');
  const minEl = document.getElementById('edit_pomodoro_minutes');
  if (!idEl || !textEl || !minEl || typeof bootstrap === 'undefined') {
    // Fallback to prompt if modal not available
    const txt = prompt("Edit task:", currentText || "");
    if (txt == null) return;
    const data = (txt || '').trim();
    if (!data) return;
    fetch("/update-note", {
      method: "POST",
      body: JSON.stringify({ noteId, data }),
    }).then((res) => res.json()).then((data) => {
      if (data.ok) window.location.reload();
    });
    return;
  }
  idEl.value = noteId;
  textEl.value = currentText || '';
  minEl.value = parseInt(currentMinutes, 10) || 25;
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('editModal'));
  modal.show();
}

function submitEditModal() {
  const idEl = document.getElementById('edit_note_id');
  const textEl = document.getElementById('edit_note_text');
  const minEl = document.getElementById('edit_pomodoro_minutes');
  const noteId = idEl.value;
  const data = (textEl.value || '').trim();
  const minutes = parseInt(minEl.value, 10);
  if (!noteId || !data) return;
  const payload = { noteId, data };
  if (Number.isInteger(minutes) && minutes > 0 && minutes <= 300) {
    payload.pomodoroSeconds = minutes * 60;
  }
  fetch("/update-note", {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((res) => res.json()).then((resp) => {
    if (resp.ok) {
      const modal = bootstrap.Modal.getInstance(document.getElementById('editModal'));
      if (modal) modal.hide();
      window.location.reload();
    }
  });
}
