import { formatDateOrTimestamp } from '@kikiutils/node/datetime';
import { addSeconds } from 'date-fns';
import { isError, readBody } from 'h3';
import type { H3Event } from 'h3';
import { random } from 'lodash-es';
import { nanoid } from 'nanoid';
import { exportKey, generateKey, getKeyUri, importKey, totp as getTotpCode } from 'otp-io';
import { hmac, randomBytes } from 'otp-io/crypto';

import { emailOtpExpirationSeconds, sendEmailOtpCodeCoolingSeconds } from '../constants';
import redisController from '../controllers/redis';
import type { AdminDocument } from '../models';
import { sendEmail } from './email';
import { createH3ErrorAndThrow } from './nitropack';

export const generateTotpSecretData = (issuer: string, name: string) => {
	const secretKey = generateKey(randomBytes, random(16, 20));
	const url = getKeyUri({
		issuer,
		name,
		secret: secretKey,
		type: 'totp'
	});

	return { secret: exportKey(secretKey), url };
};

export const requireTwoFactorAuthentication = async (event: H3Event, emailOtp: boolean = true, totp: boolean = true, admin?: AdminDocument, autoSendEmailOtpCode?: boolean) => {
	if (!(admin = admin || event.context.admin)) createH3ErrorAndThrow();
	const { emailOtpCode, totpCode } = await readBody<TwoFactorAuthenticationCodesData>(event);
	const requiredTwoFactorAuthentications = {
		emailOtp: !!(emailOtp && admin.twoFactorAuthenticationStatus.emailOtp && admin.email),
		totp: !!(totp && admin.twoFactorAuthenticationStatus.totp && admin.totpSecret)
	};

	if (requiredTwoFactorAuthentications.emailOtp) {
		if (!emailOtpCode) {
			if (autoSendEmailOtpCode) {
				try {
					await sendEmailOtpCode(admin);
				} catch (error) {
					if (!isError(error) || error.statusCode !== 429) createH3ErrorAndThrow(500, '發送Email OTP驗證碼失敗！', { requiredTwoFactorAuthentications });
				}
			}

			createH3ErrorAndThrow(400, '請輸入Email OTP驗證碼！', { requiredTwoFactorAuthentications });
		}

		if (emailOtpCode !== (await redisController.twoFactorAuthentication.emailOtpCode.get(admin))) createH3ErrorAndThrow(400, 'Email OTP驗證碼錯誤！', { requiredTwoFactorAuthentications });
		await redisController.twoFactorAuthentication.emailOtpCode.del(admin);
	}

	if (requiredTwoFactorAuthentications.totp) {
		if (!totpCode) createH3ErrorAndThrow(400, '請輸入TOTP驗證碼！', { requiredTwoFactorAuthentications });
		if (totpCode !== (await getTotpCode(hmac, { secret: importKey(admin.totpSecret!) }))) createH3ErrorAndThrow(400, 'TOTP驗證碼錯誤！', { requiredTwoFactorAuthentications });
	}
};

export const sendEmailOtpCode = async (admin: AdminDocument) => {
	if (!admin.email) createH3ErrorAndThrow(400, 'Email未綁定，無法發送OTP驗證碼！');
	const emailOtpTTL = await redisController.twoFactorAuthentication.emailOtpCode.ttl(admin);
	if (emailOtpTTL > 0 && emailOtpExpirationSeconds - emailOtpTTL < sendEmailOtpCodeCoolingSeconds) createH3ErrorAndThrow(429, 'Email OTP驗證碼已發送過，請稍後再試！');
	const emailOtpCode = nanoid(6);
	await redisController.twoFactorAuthentication.emailOtpCode.set(admin, emailOtpCode, emailOtpExpirationSeconds);
	const htmlContentTexts = [
		`您的Email OTP驗證碼為：<strong>${emailOtpCode}</strong>`,
		`此驗證碼在 ${formatDateOrTimestamp(addSeconds(new Date(), emailOtpExpirationSeconds), `yyyy-MM-dd HH:mm:ss '(UTC'XXX')'`)} 前有效。`,
		'請注意，一旦此驗證碼通過驗證，即使後續操作失敗（如登入失敗），驗證碼也會立即失效。'
	];

	return (await sendEmail(admin.email, 'Email OTP驗證碼', htmlContentTexts.join('<br />'), undefined, admin.account)).success;
};
