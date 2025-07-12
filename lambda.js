import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const BUCKET_NAME = 'tsukuba-event';
const EVENTS_FILE_KEY = 'calendar-events.json';

// CORS設定
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

// シンプルなID生成関数
function generateId() {
    const timestamp = Date.now().toString();
    const random = randomBytes(4).toString('hex');
    return `${timestamp}_${random}`;
}

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // CORS プリフライトリクエストの処理
    if (event.requestContext?.http?.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ''
        };
    }

    try {
        const httpMethod = event.requestContext.http.method;
        const rawPath = event.rawPath;
        const body = event.body;
        
        console.log('HTTP Method:', httpMethod);
        console.log('Raw Path:', rawPath);
        console.log('Body:', body);
        
        // パスから操作を判定
        const pathSegments = rawPath.split('/').filter(segment => segment);
        console.log('Path segments:', pathSegments);
        
        // /events または /events/{id} の形式を処理
        if (pathSegments.length === 0 || pathSegments[0] !== 'events') {
            return createResponse(404, { error: 'Invalid path', path: rawPath });
        }
        
        const eventId = pathSegments.length > 1 ? pathSegments[1] : null;
        console.log('Event ID:', eventId);
        
        switch (httpMethod) {
            case 'GET':
                if (!eventId) {
                    console.log('Processing GET all events');
                    return await getAllEvents();
                } else {
                    console.log('GET single event not implemented');
                    return createResponse(404, { error: 'GET single event not supported' });
                }
                
            case 'POST':
                if (!eventId) {
                    console.log('Processing POST new event');
                    return await createEvent(JSON.parse(body || '{}'));
                } else {
                    console.log('POST with ID not allowed');
                    return createResponse(400, { error: 'POST with ID not allowed' });
                }
                
            case 'PUT':
                if (eventId) {
                    console.log('Processing PUT event:', eventId);
                    return await updateEvent(eventId, JSON.parse(body || '{}'));
                } else {
                    console.log('PUT without ID not allowed');
                    return createResponse(400, { error: 'PUT requires event ID' });
                }
                
            case 'DELETE':
                if (eventId) {
                    console.log('Processing DELETE event:', eventId);
                    return await deleteEvent(eventId);
                } else {
                    console.log('DELETE without ID not allowed');
                    return createResponse(400, { error: 'DELETE requires event ID' });
                }
                
            default:
                console.log('Method not allowed:', httpMethod);
                return createResponse(405, { error: 'Method not allowed', method: httpMethod });
        }
        
    } catch (error) {
        console.error('Error:', error);
        return createResponse(500, { 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

// レスポンスヘルパー関数
function createResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        },
        body: JSON.stringify(body)
    };
}

// S3からイベントデータを取得
async function getEventsFromS3() {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: EVENTS_FILE_KEY
        });
        
        const response = await s3Client.send(command);
        const data = await response.Body.transformToString();
        return JSON.parse(data);
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return { events: [] };
        }
        throw error;
    }
}

// S3にイベントデータを保存
async function saveEventsToS3(eventsData) {
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: EVENTS_FILE_KEY,
        Body: JSON.stringify(eventsData),
        ContentType: 'application/json'
    });
    
    await s3Client.send(command);
}

// Base64画像をS3にアップロード
async function uploadImageToS3(base64Image, eventId) {
    if (!base64Image || !base64Image.startsWith('data:image/')) {
        return null;
    }
    
    try {
        // Base64データからMIMEタイプとデータ部分を分離
        const matches = base64Image.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
        if (!matches) {
            throw new Error('Invalid base64 image format');
        }
        
        const imageType = matches[1];
        const imageData = matches[2];
        const buffer = Buffer.from(imageData, 'base64');
        
        // ファイル名生成
        const fileName = `images/${eventId}_${generateId()}.${imageType}`;
        
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: `image/${imageType}`,
            ACL: 'public-read'
        });
        
        await s3Client.send(command);
        
        // 公開URLを返す
        return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'ap-northeast-1'}.amazonaws.com/${fileName}`;
        
    } catch (error) {
        console.error('Image upload error:', error);
        throw new Error('Failed to upload image');
    }
}

// S3から画像を削除
async function deleteImageFromS3(imageUrl) {
    if (!imageUrl || !imageUrl.includes(BUCKET_NAME)) {
        return;
    }
    
    try {
        // URLからキーを抽出
        const url = new URL(imageUrl);
        const key = url.pathname.substring(1); // 先頭の'/'を除去
        
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        await s3Client.send(command);
    } catch (error) {
        console.error('Image deletion error:', error);
        // 画像削除の失敗は致命的ではないので、エラーをログに記録するのみ
    }
}

// 全イベント取得
async function getAllEvents() {
    try {
        const data = await getEventsFromS3();
        return createResponse(200, {
            success: true,
            events: data.events || []
        });
    } catch (error) {
        console.error('Get events error:', error);
        return createResponse(500, {
            success: false,
            error: 'Failed to retrieve events'
        });
    }
}

// イベント作成
async function createEvent(eventData) {
    try {
        // 入力検証
        if (!eventData.title || !eventData.date) {
            return createResponse(400, {
                success: false,
                error: 'Title and date are required'
            });
        }
        
        // 終了日の検証
        const endDate = eventData.endDate || eventData.date;
        if (new Date(endDate) < new Date(eventData.date)) {
            return createResponse(400, {
                success: false,
                error: 'End date must be after or equal to start date'
            });
        }
        
        // イベントIDを生成
        const eventId = eventData.id || Date.now().toString();
        
        // 画像がある場合はS3にアップロード
        let imageUrl = null;
        if (eventData.image) {
            imageUrl = await uploadImageToS3(eventData.image, eventId);
        }
        
        // 新しいイベントオブジェクト
        const newEvent = {
            id: eventId,
            title: eventData.title,
            date: eventData.date,
            endDate: eventData.endDate || eventData.date, // 終了日を追加
            time: eventData.time || '',
            description: eventData.description || '',
            image: imageUrl,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        // 既存のイベントデータを取得
        const data = await getEventsFromS3();
        const events = data.events || [];
        
        // 新しいイベントを追加
        events.push(newEvent);
        
        // S3に保存
        await saveEventsToS3({ events });
        
        return createResponse(200, {
            success: true,
            event: newEvent,
            message: 'Event created successfully'
        });
        
    } catch (error) {
        console.error('Create event error:', error);
        return createResponse(500, {
            success: false,
            error: 'Failed to create event'
        });
    }
}

// イベント更新
async function updateEvent(eventId, eventData) {
    try {
        // 既存のイベントデータを取得
        const data = await getEventsFromS3();
        const events = data.events || [];
        
        // 更新対象のイベントを検索
        const eventIndex = events.findIndex(event => event.id == eventId);
        if (eventIndex === -1) {
            return createResponse(404, {
                success: false,
                error: 'Event not found'
            });
        }
        
        const existingEvent = events[eventIndex];
        
        // 終了日の検証
        const endDate = eventData.endDate || existingEvent.endDate || eventData.date || existingEvent.date;
        if (new Date(endDate) < new Date(eventData.date || existingEvent.date)) {
            return createResponse(400, {
                success: false,
                error: 'End date must be after or equal to start date'
            });
        }
        
        // 画像処理
        let imageUrl = existingEvent.image;
        if (eventData.image && eventData.image !== existingEvent.image) {
            // 古い画像を削除
            if (existingEvent.image) {
                await deleteImageFromS3(existingEvent.image);
            }
            // 新しい画像をアップロード
            imageUrl = await uploadImageToS3(eventData.image, eventId);
        }
        
        // イベントを更新
        const updatedEvent = {
            ...existingEvent,
            title: eventData.title || existingEvent.title,
            date: eventData.date || existingEvent.date,
            endDate: eventData.endDate || existingEvent.endDate || eventData.date || existingEvent.date, // 終了日を更新
            time: eventData.time !== undefined ? eventData.time : existingEvent.time,
            description: eventData.description !== undefined ? eventData.description : existingEvent.description,
            image: imageUrl,
            updatedAt: new Date().toISOString()
        };
        
        events[eventIndex] = updatedEvent;
        
        // S3に保存
        await saveEventsToS3({ events });
        
        return createResponse(200, {
            success: true,
            event: updatedEvent,
            message: 'Event updated successfully'
        });
        
    } catch (error) {
        console.error('Update event error:', error);
        return createResponse(500, {
            success: false,
            error: 'Failed to update event'
        });
    }
}

// イベント削除
async function deleteEvent(eventId) {
    try {
        // 既存のイベントデータを取得
        const data = await getEventsFromS3();
        const events = data.events || [];

        // 削除対象のイベントを検索
        const eventIndex = events.findIndex(event => event.id == eventId);
        console.log(eventIndex)
        if (eventIndex === -1) {
            return createResponse(404, {
                success: false,
                error: 'Event not found'
            });
        }
        
        const eventToDelete = events[eventIndex];
        
        // 関連画像を削除
        if (eventToDelete.image) {
            await deleteImageFromS3(eventToDelete.image);
        }
        
        // イベントを配列から削除
        events.splice(eventIndex, 1);
        
        // S3に保存
        await saveEventsToS3({ events });
        
        return createResponse(200, {
            success: true,
            message: 'Event deleted successfully'
        });
        
    } catch (error) {
        console.error('Delete event error:', error);
        return createResponse(500, {
            success: false,
            error: 'Failed to delete event'
        });
    }
}