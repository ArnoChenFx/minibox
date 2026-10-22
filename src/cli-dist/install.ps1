# Installs the MiniBox CLI from the server that sent this script:
#   irm <origin>/cli/install.ps1 | iex
# The server fills in its own address below. The binary is checked against the server's sha256 list before it is
# installed. MINIBOX_INSTALL_DIR chooses the folder (default %USERPROFILE%\.local\bin). No administrator rights are needed.

function Install-MiniBoxCli {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $origin = '__MINIBOX_ORIGIN__'
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "There is no MiniBox CLI for Windows $architecture yet. Build it from a checkout with bun run build:cli."
  }

  $fileName = 'minibox-windows-x64.exe'
  $dir = if ($env:MINIBOX_INSTALL_DIR) { $env:MINIBOX_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $target = Join-Path $dir 'minibox.exe'
  $download = Join-Path $dir ".minibox-download-$PID.exe"

  try {
    try {
      Invoke-WebRequest -Uri "$origin/cli/$fileName" -OutFile $download -UseBasicParsing | Out-Null
    } catch {
      $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
      throw "Could not download $fileName from ${origin}: $detail"
    }
    $sums = (Invoke-WebRequest -Uri "$origin/cli/checksums.txt" -UseBasicParsing).Content
    $expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Length -eq 2 -and $parts[1] -eq $fileName) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { throw "The server lists no checksum for $fileName." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Checksum mismatch for $fileName (expected $expected, got $actual). Nothing was installed."
    }
    Move-Item -Force -LiteralPath $download -Destination $target
  } finally {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  }

  $version = & $target --version
  if ($LASTEXITCODE -ne 0) { throw "$target was installed, but it does not run on this machine." }
  Write-Host "Installed $target ($version)"
  if (-not (($env:Path -split ';') -contains $dir)) {
    Write-Host "$dir is not on your PATH yet. Add it for your user account, then open a new terminal:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';$dir', 'User')"
  }
  Write-Host ''
  Write-Host 'Set up SSH with an access key, or an agent token that has the box:ssh scope:'
  Write-Host "  `$env:MINIBOX_URL='$origin'; `$env:MINIBOX_ACCESS_KEY='<token>'; minibox ssh-config --append"
}

Install-MiniBoxCli
