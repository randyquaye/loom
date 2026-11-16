variable "expected_account_id" {
  description = "Confirmed AWS account; both providers refuse every other account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "Use the confirmed 12-digit AWS account ID."
  }
}

variable "region" {
  description = "Region for private website objects. CloudFront certificates use us-east-1."
  type        = string
  default     = "eu-north-1"
}

variable "domain" {
  description = "Registered root domain; www is included in its certificate and aliases."
  type        = string
  default     = "loombox.xyz"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$", var.domain))
    error_message = "Use a lowercase root domain without a scheme or path."
  }
}

variable "manage_dns" {
  description = "Create the Route53 public zone. Registration remains at GoDaddy."
  type        = bool
  default     = true
}

variable "activate_custom_domain" {
  description = "Enable aliases and ACM TLS only after NS delegation and certificate issuance."
  type        = bool
  default     = false
}

variable "enable_github_deploy" {
  description = "Create the protected production-environment website deployment role."
  type        = bool
  default     = false
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider in this account; null creates one when deployment IAM is enabled."
  type        = string
  default     = null
  validation {
    condition     = var.github_oidc_provider_arn == null || var.github_oidc_provider_arn == "arn:aws:iam::${var.expected_account_id}:oidc-provider/token.actions.githubusercontent.com"
    error_message = "Use this account's token.actions.githubusercontent.com provider ARN."
  }
}
