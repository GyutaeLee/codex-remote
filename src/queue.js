class SerialQueue {
  constructor() {
    this.pending = [];
    this.processing = false;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain().catch(() => {
        // Individual job failures are handled per job.
      });
    });
  }

  cancelPending(error) {
    while (this.pending.length > 0) {
      const job = this.pending.shift();
      job.reject(error);
    }
  }

  getState() {
    return {
      length: this.pending.length,
      processing: this.processing,
    };
  }

  async drain() {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.pending.length > 0) {
      const job = this.pending.shift();

      try {
        const result = await job.task();
        job.resolve(result);
      } catch (error) {
        job.reject(error);
      }
    }

    this.processing = false;
  }
}

module.exports = {
  SerialQueue,
};
