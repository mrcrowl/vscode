# stop when there's an error
$ErrorActionPreference = 'Stop'

# set agent specific npm cache
if (Test-Path env:AGENT_WORKFOLDER) {
	$env:npm_config_cache = "${env:AGENT_WORKFOLDER}\npm-cache"
}

# throw when a process exits with something other than 0
function exec([scriptblock]$cmd, [string]$errorMessage = "Error executing command: " + $cmd) {
	& $cmd
	if ($LastExitCode -ne 0) {
		throw $errorMessage
	}
}

$Summary = @()
function step($Task, $Step) {
	echo ""
	echo "*****************************************************************************"
	echo "Start: $Task"
	echo "*****************************************************************************"
	echo ""

	$Stopwatch = [Diagnostics.Stopwatch]::StartNew()
	Invoke-Command $Step
	$Stopwatch.Stop()
	$Formatted = "{0:g}" -f $Stopwatch.Elapsed

	echo "*****************************************************************************"
	echo "End: $Task, Total: $Formatted"
	echo "*****************************************************************************"

	$global:Summary += @{ "$Task" = $Formatted }
}

function done() {
	echo ""
	echo "Build Summary"
	echo "============="
	$global:Summary | Format-Table @{L="Task";E={$_.Name}}, @{L="Duration";E={$_.Value}}
}