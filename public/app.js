// ===== Data (disimpan di localStorage) =====
let produk = JSON.parse(localStorage.getItem("produk")) || [];
let riwayat = JSON.parse(localStorage.getItem("riwayat")) || [];
let keranjang = [];

const simpan = () => {
  localStorage.setItem("produk", JSON.stringify(produk));
  localStorage.setItem("riwayat", JSON.stringify(riwayat));
};

const rupiah = (n) => "Rp " + Number(n).toLocaleString("id-ID");

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// ===== Elemen =====
const form = document.getElementById("formProduk");
const inputId = document.getElementById("produkId");
const inputNama = document.getElementById("nama");
const inputHarga = document.getElementById("harga");
const inputStok = document.getElementById("stok");
const btnSimpan = document.getElementById("btnSimpan");
const btnBatal = document.getElementById("btnBatal");
const inputCari = document.getElementById("cari");
const tabelProduk = document.getElementById("tabelProduk");
const tabelKeranjang = document.getElementById("tabelKeranjang");
const tabelRiwayat = document.getElementById("tabelRiwayat");
const elTotal = document.getElementById("total");
const inputBayar = document.getElementById("uangBayar");
const btnBayar = document.getElementById("btnBayar");
const elKembalian = document.getElementById("kembalian");

// ===== CRUD Produk =====
function renderProduk() {
  const q = inputCari.value.toLowerCase();
  const data = produk.filter((p) => p.nama.toLowerCase().includes(q));

  if (data.length === 0) {
    tabelProduk.innerHTML = `<tr><td colspan="4" class="kosong">Belum ada produk</td></tr>`;
    return;
  }

  tabelProduk.innerHTML = data
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.nama)}</td>
        <td>${rupiah(p.harga)}</td>
        <td>${p.stok}</td>
        <td class="aksi">
          <button class="small success" onclick="tambahKeKeranjang(${p.id})">+ Keranjang</button>
          <button class="small" onclick="editProduk(${p.id})">Edit</button>
          <button class="small danger" onclick="hapusProduk(${p.id})">Hapus</button>
        </td>
      </tr>`
    )
    .join("");
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const nama = inputNama.value.trim();
  const harga = Number(inputHarga.value);
  const stok = Number(inputStok.value);
  if (!nama) return;

  if (inputId.value) {
    // Update
    const p = produk.find((x) => x.id === Number(inputId.value));
    if (p) Object.assign(p, { nama, harga, stok });
  } else {
    // Create
    produk.push({ id: Date.now(), nama, harga, stok });
  }

  simpan();
  resetForm();
  renderProduk();
  renderKeranjang();
});

function editProduk(id) {
  const p = produk.find((x) => x.id === id);
  if (!p) return;
  inputId.value = p.id;
  inputNama.value = p.nama;
  inputHarga.value = p.harga;
  inputStok.value = p.stok;
  btnSimpan.textContent = "Update";
  btnBatal.hidden = false;
  inputNama.focus();
}

function hapusProduk(id) {
  if (!confirm("Hapus produk ini?")) return;
  produk = produk.filter((x) => x.id !== id);
  keranjang = keranjang.filter((x) => x.id !== id);
  simpan();
  renderProduk();
  renderKeranjang();
}

function resetForm() {
  form.reset();
  inputId.value = "";
  btnSimpan.textContent = "Tambah";
  btnBatal.hidden = true;
}

btnBatal.addEventListener("click", resetForm);
inputCari.addEventListener("input", renderProduk);

// ===== Keranjang =====
function tambahKeKeranjang(id) {
  const p = produk.find((x) => x.id === id);
  const item = keranjang.find((x) => x.id === id);
  const qtySekarang = item ? item.qty : 0;

  if (qtySekarang >= p.stok) {
    alert("Stok tidak cukup!");
    return;
  }

  if (item) item.qty++;
  else keranjang.push({ id: p.id, qty: 1 });
  renderKeranjang();
}

function ubahQty(id, delta) {
  const item = keranjang.find((x) => x.id === id);
  const p = produk.find((x) => x.id === id);
  if (!item || !p) return;

  item.qty += delta;
  if (item.qty > p.stok) {
    item.qty = p.stok;
    alert("Stok tidak cukup!");
  }
  if (item.qty <= 0) keranjang = keranjang.filter((x) => x.id !== id);
  renderKeranjang();
}

function hitungTotal() {
  return keranjang.reduce((sum, item) => {
    const p = produk.find((x) => x.id === item.id);
    return sum + (p ? p.harga * item.qty : 0);
  }, 0);
}

function renderKeranjang() {
  if (keranjang.length === 0) {
    tabelKeranjang.innerHTML = `<tr><td colspan="4" class="kosong">Keranjang kosong</td></tr>`;
  } else {
    tabelKeranjang.innerHTML = keranjang
      .map((item) => {
        const p = produk.find((x) => x.id === item.id);
        return `
        <tr>
          <td>${escapeHtml(p.nama)}</td>
          <td class="aksi">
            <button class="small secondary" onclick="ubahQty(${item.id}, -1)">-</button>
            ${item.qty}
            <button class="small secondary" onclick="ubahQty(${item.id}, 1)">+</button>
          </td>
          <td>${rupiah(p.harga * item.qty)}</td>
          <td><button class="small danger" onclick="ubahQty(${item.id}, -${item.qty})">x</button></td>
        </tr>`;
      })
      .join("");
  }
  elTotal.textContent = rupiah(hitungTotal());
}

// ===== Pembayaran =====
btnBayar.addEventListener("click", () => {
  if (keranjang.length === 0) {
    alert("Keranjang masih kosong!");
    return;
  }

  const total = hitungTotal();
  const bayar = Number(inputBayar.value);

  if (bayar < total) {
    alert("Uang bayar kurang!");
    return;
  }

  const kembali = bayar - total;

  // Kurangi stok
  const items = keranjang.map((item) => {
    const p = produk.find((x) => x.id === item.id);
    p.stok -= item.qty;
    return { nama: p.nama, qty: item.qty, harga: p.harga };
  });

  riwayat.unshift({
    id: Date.now(),
    waktu: new Date().toLocaleString("id-ID"),
    items,
    total,
    bayar,
    kembali,
  });

  keranjang = [];
  inputBayar.value = "";
  elKembalian.textContent = "Kembalian: " + rupiah(kembali);

  simpan();
  renderProduk();
  renderKeranjang();
  renderRiwayat();
});

// ===== Riwayat =====
function renderRiwayat() {
  if (riwayat.length === 0) {
    tabelRiwayat.innerHTML = `<tr><td colspan="6" class="kosong">Belum ada transaksi</td></tr>`;
    return;
  }

  tabelRiwayat.innerHTML = riwayat
    .map(
      (r) => `
      <tr>
        <td>${r.waktu}</td>
        <td>${r.items.map((i) => `${escapeHtml(i.nama)} x${i.qty}`).join(", ")}</td>
        <td>${rupiah(r.total)}</td>
        <td>${rupiah(r.bayar)}</td>
        <td>${rupiah(r.kembali)}</td>
        <td><button class="small danger" onclick="hapusRiwayat(${r.id})">Hapus</button></td>
      </tr>`
    )
    .join("");
}

function hapusRiwayat(id) {
  if (!confirm("Hapus riwayat ini?")) return;
  riwayat = riwayat.filter((x) => x.id !== id);
  simpan();
  renderRiwayat();
}

// ===== Init =====
renderProduk();
renderKeranjang();
renderRiwayat();
