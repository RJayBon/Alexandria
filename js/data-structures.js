/* ==========================================================================
   ALEXANDRIA · data-structures.js
   Every structure below is implemented from scratch for the DSA course —
   no Array.sort / Map / Set shortcuts power the core logic.
   ========================================================================== */

'use strict';

/* ------------------------------ Linked Node ------------------------------ */
/* Shared building block for the Linked List, Stack and Queue. */
class Node {
  constructor(data) {
    this.data = data;
    this.next = null;
  }
}

/* =========================== SINGLY LINKED LIST ===========================
   Used for: BORROWING HISTORY.
   New transactions are inserted at the HEAD → the ledger is newest-first
   in O(1), with zero sorting passes. Traversal walks head → tail.         */
class SinglyLinkedList {
  constructor() {
    this.head = null;
    this._size = 0;
  }
  get size() { return this._size; }

  insertAtHead(data) {                 // O(1) — the whole point of the ledger
    const node = new Node(data);
    node.next = this.head;
    this.head = node;
    this._size++;
    return node;
  }

  removeWhere(pred) {                  // O(n) — available for future deletes
    if (!this.head) return false;
    if (pred(this.head.data)) {
      this.head = this.head.next;
      this._size--;
      return true;
    }
    let prev = this.head, cur = this.head.next;
    while (cur) {
      if (pred(cur.data)) {
        prev.next = cur.next;
        this._size--;
        return true;
      }
      prev = cur; cur = cur.next;
    }
    return false;
  }

  forEach(fn) {                        // O(n) traversal, head → tail
    let cur = this.head, i = 0;
    while (cur) { fn(cur.data, i); cur = cur.next; i++; }
  }

  toArray() {
    const out = [];
    this.forEach(d => out.push(d));
    return out;
  }
}

/* ================================= STACK ==================================
   Used for: CHECK-IN UNDO.
   Each check-in pushes a checkpoint; "Undo" pops the most recent one.
   LIFO matches how mistakes are corrected: last action reverts first.      */
class Stack {
  constructor() {
    this.top = null;
    this._size = 0;
  }
  get size() { return this._size; }

  push(data) {                         // O(1)
    const node = new Node(data);
    node.next = this.top;
    this.top = node;
    this._size++;
  }

  pop() {                              // O(1)
    if (!this.top) return null;
    const data = this.top.data;
    this.top = this.top.next;
    this._size--;
    return data;
  }

  peek() { return this.top ? this.top.data : null; }  // O(1)
  isEmpty() { return this.top === null; }

  toArray() {                          // top → bottom
    const out = [];
    let cur = this.top;
    while (cur) { out.push(cur.data); cur = cur.next; }
    return out;
  }
}

/* ================================= QUEUE ==================================
   Used for: per-book WAITLISTS and the TOAST NOTIFICATION pipeline.
   enqueue at rear, dequeue from front — fair FIFO in O(1) both ways.
   Implemented on a linked list with front/rear pointers.                   */
class Queue {
  constructor() {
    this.front = null;
    this.rear = null;
    this._size = 0;
  }
  get size() { return this._size; }
  isEmpty() { return this._size === 0; }

  enqueue(data) {                      // O(1) — join the back of the line
    const node = new Node(data);
    if (this.rear) this.rear.next = node;
    else this.front = node;
    this.rear = node;
    this._size++;
  }

  dequeue() {                          // O(1) — serve the front of the line
    if (!this.front) return null;
    const data = this.front.data;
    this.front = this.front.next;
    if (!this.front) this.rear = null;
    this._size--;
    return data;
  }

  peek() { return this.front ? this.front.data : null; }

  /* Used ONLY by the undo flow: when a check-in that handed the book to the
     queue-front patron is reversed, that patron is restored to the FRONT of
     the line (their original position), preserving fairness. */
  enqueueFront(data) {                 // O(n) — rebuild via standard ops
    const rebuilt = new Queue();
    rebuilt.enqueue(data);
    let cur = this.front;
    while (cur) { rebuilt.enqueue(cur.data); cur = cur.next; }
    this.front = rebuilt.front;
    this.rear = rebuilt.rear;
    this._size = rebuilt._size;
  }

  toArray() {                          // front → rear
    const out = [];
    let cur = this.front;
    while (cur) { out.push(cur.data); cur = cur.next; }
    return out;
  }
}

/* ============================ BINARY SEARCH TREE ===========================
   Used for: the CATALOG. Key = lowercased title.
   - search()  → exact title lookup with a comparison counter (shown in UI)
   - inOrder() → alphabetical listing "for free", feeding the book grid     */
class BSTNode {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.left = null;
    this.right = null;
  }
}

class BinarySearchTree {
  constructor() {
    this.root = null;
    this.count = 0;
    this.lastComparisons = 0;          // instrumentation for the search bar
  }

  insert(key, value) {
    key = String(key);
    if (!this.root) { this.root = new BSTNode(key, value); this.count++; return; }
    let cur = this.root;
    while (true) {
      if (key === cur.key) { cur.value = value; return; }           // update
      if (key < cur.key) {
        if (!cur.left) { cur.left = new BSTNode(key, value); this.count++; return; }
        cur = cur.left;
      } else {
        if (!cur.right) { cur.right = new BSTNode(key, value); this.count++; return; }
        cur = cur.right;
      }
    }
  }

  search(key) {                        // O(h) — h = tree height
    this.lastComparisons = 0;
    let cur = this.root;
    const target = String(key).toLowerCase();
    while (cur) {
      this.lastComparisons++;
      if (target === cur.key) return cur.value;
      cur = target < cur.key ? cur.left : cur.right;
    }
    return null;
  }

  inOrder() {                          // O(n) — alphabetical traversal
    const out = [];
    (function walk(node) {
      if (!node) return;
      walk(node.left);
      out.push(node.value);
      walk(node.right);
    })(this.root);
    return out;
  }

  height() {
    return (function h(node) {
      if (!node) return 0;
      return 1 + Math.max(h(node.left), h(node.right));
    })(this.root);
  }
}

/* ================================ HASH TABLE ================================
   Used for: O(1) AVAILABILITY + LOAN lookups (ISBN / loan id → record).
   djb2 string hash, 31 buckets, collision resolution by chaining.          */
class HashTable {
  constructor(bucketCount = 31) {
    this.bucketCount = bucketCount;
    this.buckets = [];
    for (let i = 0; i < bucketCount; i++) this.buckets.push([]);
    this.entries = 0;
  }

  hash(key) {
    let h = 5381;
    const str = String(key);
    for (let i = 0; i < str.length; i++) {
      h = ((h * 33) + str.charCodeAt(i)) >>> 0;   // djb2, kept in uint32
    }
    return h % this.bucketCount;
  }

  set(key, value) {
    const idx = this.hash(key);
    const bucket = this.buckets[idx];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].key === key) { bucket[i].value = value; return; }
    }
    bucket.push({ key, value });
    this.entries++;
  }

  get(key) {
    const bucket = this.buckets[this.hash(key)];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].key === key) return bucket[i].value;
    }
    return null;
  }

  /* Introspection for the DS docs panel (live metrics). */
  collisions() {
    let c = 0;
    for (const b of this.buckets) if (b.length > 1) c++;
    return c;
  }
}

/* expose for console exploration during the demo */
window.DS = { Node, SinglyLinkedList, Stack, Queue, BinarySearchTree, HashTable };
