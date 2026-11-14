variable "stack_name" {
  description = "One stack owns its names, state, parameters and snapshots. loom preserves the original pilot names."
  type        = string
  default     = "loom"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,16}$", var.stack_name))
    error_message = "Use at most 17 lowercase letters, digits and hyphens, beginning with a letter."
  }
}

variable "expected_account_id" {
  description = "The account confirmed by the stack loader; the provider refuses any other account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Use a 12-digit AWS account id."
  }
}

variable "subnet_id" {
  description = "Optional public subnet; VPC and data-disk zone follow it. Otherwise use the Region's default a-zone subnet."
  type        = string
  default     = null
}

variable "region" {
  description = "The project's one Region."
  type        = string
  default     = "eu-north-1"
}

variable "hostname" {
  description = "DNS name people reach the runner at. Its A record must point at the host's address."
  type        = string
}

variable "instance_type" {
  description = "Must be x86_64, so a change of size never needs a rebuilt host."
  type        = string
  default     = "m7i-flex.large"
}

variable "enable_kata_workspaces" {
  description = "Kata workspace VMs and nested virtualization. Changing this may stop the host."
  type        = bool
  default     = true
}

variable "root_gb" {
  description = "Operating system, Docker images and the runner itself. Rebuildable."
  type        = number
  default     = 30
}

variable "data_gb" {
  description = "Everything Loom writes: checkouts, user homes, database, logs. Backed up daily."
  type        = number
  default     = 50
}

variable "snapshot_time_utc" {
  description = "Daily snapshot time, in UTC."
  type        = string
  default     = "02:00"
  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.snapshot_time_utc))
    error_message = "Use a UTC time in HH:MM format."
  }
}

variable "snapshot_retention" {
  description = "Number of daily data-disk snapshots to retain."
  type        = number
  default     = 7
  validation {
    condition     = var.snapshot_retention >= 1 && var.snapshot_retention <= 365 && floor(var.snapshot_retention) == var.snapshot_retention
    error_message = "Retain between 1 and 365 daily snapshots."
  }
}

variable "alarm_email" {
  description = "Alarm recipient. Both regional and Route 53 SNS subscriptions must be confirmed. Null leaves monitoring disabled."
  type        = string
  default     = null
  validation {
    condition     = var.alarm_email == null ? true : can(regex("^[^[:space:]@]+@[^[:space:]@]+$", var.alarm_email))
    error_message = "Use an email address or null."
  }
}
