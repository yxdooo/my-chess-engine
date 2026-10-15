# Aether Chess Engine - Profile-Guided Optimization (PGO) Build Script
# Targets native x86_64 MSVC with AVX2/BMI2 hardware acceleration

param(
    [int]$BenchDepth = 12,
    [switch]$SkipComponentInstall
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Aether Engine: Profile-Guided Optimization (PGO) Build   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Ensure llvm-tools-preview is installed
if (-not $SkipComponentInstall) {
    Write-Host "[1/6] Checking llvm-tools-preview component..." -ForegroundColor Yellow
    rustup component add llvm-tools-preview
}

$Sysroot = (rustc --print sysroot).Trim()
$HostTarget = (rustc -vV | Select-String "host: (.*)").Matches.Groups[1].Value.Trim()
$LlvmProfdata = Join-Path $Sysroot "lib\rustlib\$HostTarget\bin\llvm-profdata.exe"

if (-not (Test-Path $LlvmProfdata)) {
    $Found = Get-ChildItem -Path $Sysroot -Filter "llvm-profdata.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Found) {
        $LlvmProfdata = $Found.FullName
    } else {
        Write-Error "llvm-profdata.exe not found in rustup sysroot. Run: rustup component add llvm-tools-preview"
        exit 1
    }
}
Write-Host "[1/6] Found LLVM profdata tool: $LlvmProfdata" -ForegroundColor Green

$EngineDir = (Resolve-Path (Join-Path $PSScriptRoot "..\engine-wasm")).Path
$PgoDataDir = Join-Path $EngineDir "target\pgo-data"

# 2. Clean previous profile data
Write-Host "[2/6] Preparing PGO directory: $PgoDataDir" -ForegroundColor Yellow
if (Test-Path $PgoDataDir) {
    Remove-Item -Recurse -Force $PgoDataDir
}
New-Item -ItemType Directory -Force -Path $PgoDataDir | Out-Null

$PgoDataDirNorm = $PgoDataDir -replace '\\', '/'

# 3. Build instrumented binary
Write-Host "[3/6] Building instrumented binary (-Cprofile-generate)..." -ForegroundColor Yellow
$OrigRustFlags = $env:RUSTFLAGS
$env:RUSTFLAGS = "-Cprofile-generate=$PgoDataDirNorm -Ctarget-cpu=native"

try {
    Push-Location $EngineDir
    cargo build --release --bin uci
} finally {
    Pop-Location
}

$UciBin = Join-Path $EngineDir "target\release\uci.exe"
if (-not (Test-Path $UciBin)) {
    Write-Error "Instrumented UCI binary not found at $UciBin"
    exit 1
}

# 4. Generate profile data using bench
Write-Host "[4/6] Running benchmark workload to collect PGO training traces (depth $BenchDepth)..." -ForegroundColor Yellow
& $UciBin bench $BenchDepth

# 5. Merge profile data
Write-Host "[5/6] Merging profile data into merged.profdata..." -ForegroundColor Yellow
$MergedProfdata = Join-Path $PgoDataDir "merged.profdata"
$ProfrawFiles = Get-ChildItem -Path $PgoDataDir -Filter "*.profraw"

if ($ProfrawFiles.Count -eq 0) {
    Write-Error "No .profraw files found in $PgoDataDir!"
    exit 1
}

& $LlvmProfdata merge -output="$MergedProfdata" ($ProfrawFiles | ForEach-Object { $_.FullName })
Write-Host "[5/6] Successfully created merged profile: $MergedProfdata" -ForegroundColor Green

$MergedProfdataNorm = $MergedProfdata -replace '\\', '/'

# 6. Build optimized binary with profile feedback
Write-Host "[6/6] Building final PGO-optimized binary (-Cprofile-use)..." -ForegroundColor Yellow
$env:RUSTFLAGS = "-Cprofile-use=$MergedProfdataNorm -Ctarget-cpu=native -Cllvm-args=-pgo-warn-missing-function"

try {
    Push-Location $EngineDir
    cargo build --release --bin uci
} finally {
    Pop-Location
    $env:RUSTFLAGS = $OrigRustFlags
}

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   PGO Build Complete! Benchmarking optimized binary...   " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
& $UciBin bench 12
