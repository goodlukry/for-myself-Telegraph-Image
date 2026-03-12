import { errorHandling, telemetryData } from "./utils/middleware";

const ALLOWED_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/bmp',
    'image/svg+xml',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/avif',
]);

const ALLOWED_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'bmp',
    'svg',
    'ico',
    'avif',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;

function jsonError(message, status = 400) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function isAllowedImage(uploadFile, fileExtension) {
    return ALLOWED_IMAGE_TYPES.has(uploadFile.type) && ALLOWED_EXTENSIONS.has(fileExtension);
}

function isAuthorized(request, formData, env) {
    if (!env.UPLOAD_KEY) return true;

    const authHeader = request.headers.get('x-upload-key');
    const authFromQuery = new URL(request.url).searchParams.get('key');
    const authFromForm = formData.get('key');

    return authHeader === env.UPLOAD_KEY || authFromQuery === env.UPLOAD_KEY || authFromForm === env.UPLOAD_KEY;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        if (!isAuthorized(request, formData, env)) {
            return jsonError('Unauthorized upload request', 401);
        }

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            return jsonError('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        if (!isAllowedImage(uploadFile, fileExtension)) {
            return jsonError('Only image uploads are allowed');
        }

        if (uploadFile.size > MAX_FILE_SIZE) {
            return jsonError('Image too large, max size is 10MB');
        }

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);
        telegramFormData.append("photo", uploadFile);

        const result = await sendToTelegram(telegramFormData, env);

        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                }
            });
        }

        return new Response(
            JSON.stringify([{ 'src': `/file/${fileId}.${fileExtension}` }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendPhoto`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}