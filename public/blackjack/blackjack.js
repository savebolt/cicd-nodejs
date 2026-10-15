// ===== Data (disimpan di localStorage) =====
const AWAL = 1000;

let chip = Number(localStorage.getItem("bj_chip"));
if (!Number.isFinite(chip) || chip < 0) chip = AWAL;

let stat = JSON.parse(localStorage.getItem("bj_stat")) || { menang: 0, kalah: 0, seri: 0, bj: 0 };
let riwayat = JSON.parse(localStorage.getItem("bj_riwayat")) || [];

const simpan = () => {
  localStorage.setItem("bj_chip", String(chip));
  localStorage.setItem("bj_stat", JSON.stringify(stat));
  localStorage.setItem("bj_riwayat", JSON.stringify(riwayat.slice(0, 20)));
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// ===== Elemen =====
const elChip = document.getElementById("chip");
const elTaruhanAktif = document.getElementById("taruhanAktif");
const inputTaruhan = document.getElementById("taruhan");
const btnBagi = document.getElementById("btnBagi");
const btnHit = document.getElementById("btnHit");
const btnStand = document.getElementById("btnStand");
const btnDouble = document.getElementById("btnDouble");
const btnReset = document.getElementById("btnReset");
const kartuBandar = document.getElementById("kartuBandar");
const kartuPemain = document.getElementById("kartuPemain");
const nilaiBandar = document.getElementById("nilaiBandar");
const nilaiPemain = document.getElementById("nilaiPemain");
const elPesan = document.getElementById("pesan");
const elSisa = document.getElementById("sisaKartu");
const tabelRiwayat = document.getElementById("tabelRiwayat");

// ===== Kartu =====
const JENIS = [
  { simbol: "\u2660", merah: false },
  { simbol: "\u2663", merah: false },
  { simbol: "\u2665", merah: true },
  { simbol: "\u2666", merah: true },
];
const ANGKA = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

let dek = [];
let tanganPemain = [];
let tanganBandar = [];
let taruhan = 0;
let ronde = false;

function buatDek() {
  // 4 dek, diacak dengan Fisher-Yates.
  dek = [];
  for (let d = 0; d < 4; d++) {
    for (const jenis of JENIS) {
      for (const angka of ANGKA) dek.push({ angka, ...jenis });
    }
  }
  for (let i = dek.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dek[i], dek[j]] = [dek[j], dek[i]];
  }
}

function ambilKartu() {
  // Kocok ulang sebelum dek habis supaya ronde tidak pernah terputus.
  if (dek.length < 15) buatDek();
  return dek.pop();
}

function hitungNilai(tangan) {
  let total = 0;
  let as = 0;

  for (const kartu of tangan) {
    if (kartu.angka === "A") {
      as++;
      total += 11;
    } else if (["J", "Q", "K"].includes(kartu.angka)) {
      total += 10;
    } else {
      total += Number(kartu.angka);
    }
  }

  // As dihitung 1 kalau 11 bikin bust.
  while (total > 21 && as > 0) {
    total -= 10;
    as--;
  }

  return total;
}

const isBlackjack = (tangan) => tangan.length === 2 && hitungNilai(tangan) === 21;

// ===== Render =====
function kartuHtml(kartu, tertutup) {
  if (tertutup) return `<div class="kartu tertutup"></div>`;

  const label = `${escapeHtml(kartu.angka)}${kartu.simbol}`;
  return `<div class="kartu ${kartu.merah ? "merah" : ""}">
      <span>${label}</span>
      <span class="bawah">${label}</span>
    </div>`;
}

function render() {
  const sembunyi = ronde && tanganBandar.length > 1;

  kartuPemain.innerHTML = tanganPemain.map((k) => kartuHtml(k, false)).join("");
  kartuBandar.innerHTML = tanganBandar.map((k, i) => kartuHtml(k, sembunyi && i === 1)).join("");

  nilaiPemain.textContent = tanganPemain.length ? `(${hitungNilai(tanganPemain)})` : "";
  if (!tanganBandar.length) nilaiBandar.textContent = "";
  else if (sembunyi) nilaiBandar.textContent = `(${hitungNilai([tanganBandar[0]])} + ?)`;
  else nilaiBandar.textContent = `(${hitungNilai(tanganBandar)})`;

  elChip.textContent = chip.toLocaleString("id-ID");
  elSisa.textContent = dek.length;

  elTaruhanAktif.hidden = !ronde;
  if (ronde) elTaruhanAktif.textContent = `Taruhan: ${taruhan.toLocaleString("id-ID")}`;

  document.getElementById("statMenang").textContent = stat.menang;
  document.getElementById("statKalah").textContent = stat.kalah;
  document.getElementById("statSeri").textContent = stat.seri;
  document.getElementById("statBj").textContent = stat.bj;

  btnBagi.disabled = ronde;
  inputTaruhan.disabled = ronde;
  btnHit.disabled = !ronde;
  btnStand.disabled = !ronde;
  // Double hanya boleh di 2 kartu pertama dan kalau chip cukup.
  btnDouble.disabled = !ronde || tanganPemain.length !== 2 || chip < taruhan;
  btnReset.disabled = ronde;
}

function renderRiwayat() {
  if (riwayat.length === 0) {
    tabelRiwayat.innerHTML = `<tr><td colspan="6" class="kosong">Belum ada ronde</td></tr>`;
    return;
  }

  tabelRiwayat.innerHTML = riwayat
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.waktu)}</td>
        <td>${r.taruhan.toLocaleString("id-ID")}</td>
        <td>${r.pemain}</td>
        <td>${r.bandar}</td>
        <td>${escapeHtml(r.hasil)}</td>
        <td>${r.chip.toLocaleString("id-ID")}</td>
      </tr>`
    )
    .join("");
}

function pesan(teks, kelas) {
  elPesan.textContent = teks;
  elPesan.className = `pesan ${kelas || ""}`;
}

// ===== Jalannya ronde =====
function mulai() {
  const nilai = Math.floor(Number(inputTaruhan.value));

  if (!Number.isFinite(nilai) || nilai < 1) {
    alert("Taruhan tidak valid!");
    return;
  }
  if (nilai > chip) {
    alert("Chip tidak cukup!");
    return;
  }

  taruhan = nilai;
  chip -= taruhan;
  tanganPemain = [ambilKartu(), ambilKartu()];
  tanganBandar = [ambilKartu(), ambilKartu()];
  ronde = true;

  pesan("");
  render();

  const bjPemain = isBlackjack(tanganPemain);
  const bjBandar = isBlackjack(tanganBandar);

  if (bjPemain || bjBandar) {
    if (bjPemain && bjBandar) selesai("seri", "Dua-duanya blackjack, seri!");
    // Blackjack dibayar 3:2.
    else if (bjPemain) selesai("blackjack", "Blackjack! Kamu menang 3:2");
    else selesai("kalah", "Bandar blackjack, kamu kalah");
  }
}

function hit() {
  tanganPemain.push(ambilKartu());
  const nilai = hitungNilai(tanganPemain);

  if (nilai > 21) {
    render();
    selesai("kalah", `Bust dengan ${nilai}, kamu kalah`);
    return;
  }

  // 21 otomatis stand, tidak ada gunanya menambah kartu.
  if (nilai === 21) {
    render();
    stand();
    return;
  }

  render();
}

function doubleDown() {
  if (chip < taruhan) return;

  chip -= taruhan;
  taruhan *= 2;
  tanganPemain.push(ambilKartu());

  const nilai = hitungNilai(tanganPemain);
  render();

  if (nilai > 21) selesai("kalah", `Bust dengan ${nilai}, kamu kalah`);
  else stand();
}

function stand() {
  // Bandar wajib ambil kartu sampai 17.
  while (hitungNilai(tanganBandar) < 17) tanganBandar.push(ambilKartu());

  const pemain = hitungNilai(tanganPemain);
  const bandar = hitungNilai(tanganBandar);

  if (bandar > 21) selesai("menang", `Bandar bust dengan ${bandar}, kamu menang!`);
  else if (pemain > bandar) selesai("menang", `${pemain} lawan ${bandar}, kamu menang!`);
  else if (pemain < bandar) selesai("kalah", `${pemain} lawan ${bandar}, kamu kalah`);
  else selesai("seri", `${pemain} sama-sama, seri`);
}

function selesai(hasil, teks) {
  ronde = false;

  let bayar = 0;
  let label = "";

  if (hasil === "blackjack") {
    bayar = taruhan + Math.floor(taruhan * 1.5);
    stat.menang++;
    stat.bj++;
    label = "Blackjack";
  } else if (hasil === "menang") {
    bayar = taruhan * 2;
    stat.menang++;
    label = "Menang";
  } else if (hasil === "seri") {
    bayar = taruhan;
    stat.seri++;
    label = "Seri";
  } else {
    stat.kalah++;
    label = "Kalah";
  }

  chip += bayar;

  riwayat.unshift({
    waktu: new Date().toLocaleTimeString("id-ID"),
    taruhan,
    pemain: hitungNilai(tanganPemain),
    bandar: hitungNilai(tanganBandar),
    hasil: label,
    chip,
  });
  riwayat = riwayat.slice(0, 20);

  const kelas = hasil === "kalah" ? "kalah" : hasil === "seri" ? "seri" : "menang";
  pesan(teks, kelas);

  simpan();
  render();
  renderRiwayat();

  if (chip === 0) {
    pesan(`${teks} - chip habis, reset untuk main lagi.`, "kalah");
  }
}

// ===== Event =====
btnBagi.addEventListener("click", mulai);
btnHit.addEventListener("click", hit);
btnStand.addEventListener("click", stand);
btnDouble.addEventListener("click", doubleDown);

document.querySelectorAll("[data-chip]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (ronde) return;
    const nilai = btn.dataset.chip;
    if (nilai === "max") {
      inputTaruhan.value = chip;
      return;
    }
    inputTaruhan.value = Math.min(chip, Number(inputTaruhan.value || 0) + Number(nilai));
  });
});

btnReset.addEventListener("click", () => {
  if (!confirm("Reset chip ke 1000 dan hapus statistik?")) return;
  chip = AWAL;
  stat = { menang: 0, kalah: 0, seri: 0, bj: 0 };
  riwayat = [];
  tanganPemain = [];
  tanganBandar = [];
  ronde = false;
  inputTaruhan.value = 50;
  pesan("");
  simpan();
  render();
  renderRiwayat();
});

buatDek();
render();
renderRiwayat();
if (chip === 0) pesan("Chip habis, reset untuk main lagi.", "kalah");
